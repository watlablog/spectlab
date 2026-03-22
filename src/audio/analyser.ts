import type { FrameSize, UpperFrequencyHz } from '../app/types'

const UPPER_FREQUENCY_WORKLET_URL = new URL('./worklets/upperFrequencyProcessor.js', import.meta.url)
const CAPTURE_WORKLET_URL = new URL('./worklets/captureProcessor.js', import.meta.url)
const PREFERRED_SAMPLE_RATES_HZ = [16000, 22050, 32000, 44100, 48000, 96000] as const

function resolveAudioContextSampleRate(upperFrequencyHz: UpperFrequencyHz): number {
  const minimumSampleRateHz = Math.ceil(upperFrequencyHz * 2)
  for (const candidateHz of PREFERRED_SAMPLE_RATES_HZ) {
    if (candidateHz >= minimumSampleRateHz) {
      return candidateHz
    }
  }
  return minimumSampleRateHz
}

export interface CaptureChunk {
  samples: Float32Array
  nativeSampleRateHz: number
  capturedSamplesNative: number
}

export interface CaptureWindowSnapshot {
  samples: Float32Array
  sampleRateHz: number
  capturedSamplesNative: number
}

export interface AnalyserPipeline {
  audioContext: AudioContext
  sourceNode: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  requestWindowSnapshot: () => Promise<CaptureWindowSnapshot | null>
  disconnect: () => void
}

export async function createAnalyserPipeline(
  stream: MediaStream,
  options: {
    fftSize: FrameSize
    upperFrequencyHz: UpperFrequencyHz
    onCaptureChunk?: (chunk: CaptureChunk) => void
  },
): Promise<AnalyserPipeline> {
  const requestedSampleRateHz = resolveAudioContextSampleRate(options.upperFrequencyHz)
  const audioContext = new AudioContext({ sampleRate: requestedSampleRateHz })
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  if ((audioContext.sampleRate / 2) + 1 < options.upperFrequencyHz) {
    console.warn(
      `Requested upper frequency ${options.upperFrequencyHz}Hz, but active Nyquist is ${Math.round(
        audioContext.sampleRate / 2,
      )}Hz.`,
    )
  }

  const sourceNode = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()

  analyser.fftSize = options.fftSize
  analyser.smoothingTimeConstant = 0.8

  let filterNode: AudioWorkletNode | null = null
  let captureNode: AudioWorkletNode | null = null
  let captureGainNode: GainNode | null = null
  const pendingSnapshotResolvers = new Map<number, (snapshot: CaptureWindowSnapshot | null) => void>()
  let nextSnapshotRequestId = 1

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

  try {
    await audioContext.audioWorklet.addModule(CAPTURE_WORKLET_URL.href)
    captureNode = new AudioWorkletNode(audioContext, 'capture-processor')
    captureGainNode = audioContext.createGain()
    captureGainNode.gain.value = 0
    sourceNode.connect(captureNode)
    captureNode.connect(captureGainNode)
    captureGainNode.connect(audioContext.destination)
    captureNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') {
        return
      }

      if (data.type === 'capture-chunk') {
        const samples = data.samples
        if (!(samples instanceof Float32Array)) {
          return
        }
        options.onCaptureChunk?.({
          samples,
          nativeSampleRateHz: Number(data.nativeSampleRateHz),
          capturedSamplesNative: Number(data.capturedSamplesNative),
        })
        return
      }

      if (data.type === 'snapshot-response') {
        const requestId = Number(data.requestId)
        const resolver = pendingSnapshotResolvers.get(requestId)
        if (!resolver) {
          return
        }
        pendingSnapshotResolvers.delete(requestId)
        const samples = data.samples
        if (!(samples instanceof Float32Array)) {
          resolver(null)
          return
        }
        resolver({
          samples,
          sampleRateHz: Number(data.sampleRateHz),
          capturedSamplesNative: Number(data.capturedSamplesNative),
        })
      }
    }
  } catch (error) {
    throw new Error(
      `Capture AudioWorklet initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (filterNode) {
    sourceNode.connect(filterNode)
    filterNode.connect(analyser)
  } else {
    sourceNode.connect(analyser)
  }

  return {
    audioContext,
    analyser,
    sourceNode,
    requestWindowSnapshot: () =>
      new Promise<CaptureWindowSnapshot | null>((resolve) => {
        if (!captureNode) {
          resolve(null)
          return
        }
        const requestId = nextSnapshotRequestId
        nextSnapshotRequestId += 1
        pendingSnapshotResolvers.set(requestId, resolve)
        captureNode.port.postMessage({
          type: 'snapshot-request',
          requestId,
        })
      }),
    disconnect: () => {
      for (const [, resolver] of pendingSnapshotResolvers) {
        resolver(null)
      }
      pendingSnapshotResolvers.clear()

      sourceNode.disconnect()
      if (filterNode) {
        filterNode.disconnect()
      }
      if (captureNode) {
        captureNode.port.onmessage = null
        captureNode.disconnect()
      }
      if (captureGainNode) {
        captureGainNode.disconnect()
      }
      analyser.disconnect()
    },
  }
}
