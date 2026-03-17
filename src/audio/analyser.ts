import type { FrameSize, UpperFrequencyHz } from '../app/types'

const UPPER_FREQUENCY_WORKLET_URL = new URL('./worklets/upperFrequencyProcessor.js', import.meta.url)

export interface AnalyserPipeline {
  audioContext: AudioContext
  analyser: AnalyserNode
  sourceNode: MediaStreamAudioSourceNode
  timeDomainData: Float32Array<ArrayBuffer>
  disconnect: () => void
}

export async function createAnalyserPipeline(
  stream: MediaStream,
  options: {
    fftSize: FrameSize
    upperFrequencyHz: UpperFrequencyHz
    onPcmFrame?: (frame: Float32Array) => void
  },
): Promise<AnalyserPipeline> {
  const audioContext = new AudioContext()
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  const sourceNode = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()

  analyser.fftSize = options.fftSize
  analyser.smoothingTimeConstant = 0.8

  let filterNode: AudioWorkletNode | null = null
  try {
    await audioContext.audioWorklet.addModule(UPPER_FREQUENCY_WORKLET_URL.href)
    filterNode = new AudioWorkletNode(audioContext, 'upper-frequency-processor')
    const cutoffParam = filterNode.parameters.get('cutoffHz')
    if (cutoffParam) {
      cutoffParam.value = options.upperFrequencyHz
    }
  } catch (error) {
    console.warn('AudioWorklet initialization failed. Falling back without upper-frequency filtering.', error)
  }

  if (filterNode) {
    sourceNode.connect(filterNode)
    filterNode.connect(analyser)
  } else {
    sourceNode.connect(analyser)
  }

  let captureNode: ScriptProcessorNode | null = null
  let captureGainNode: GainNode | null = null
  if (typeof audioContext.createScriptProcessor === 'function') {
    captureNode = audioContext.createScriptProcessor(2048, 1, 1)
    captureGainNode = audioContext.createGain()
    captureGainNode.gain.value = 0

    captureNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0)
      options.onPcmFrame?.(new Float32Array(input))
    }

    sourceNode.connect(captureNode)
    captureNode.connect(captureGainNode)
    captureGainNode.connect(audioContext.destination)
  }

  return {
    audioContext,
    analyser,
    sourceNode,
    timeDomainData: new Float32Array(analyser.fftSize),
    disconnect: () => {
      sourceNode.disconnect()
      if (filterNode) {
        filterNode.disconnect()
      }
      if (captureNode) {
        captureNode.onaudioprocess = null
        captureNode.disconnect()
      }
      if (captureGainNode) {
        captureGainNode.disconnect()
      }
      analyser.disconnect()
    },
  }
}
