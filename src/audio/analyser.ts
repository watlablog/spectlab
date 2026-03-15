export interface AnalyserPipeline {
  audioContext: AudioContext
  analyser: AnalyserNode
  sourceNode: MediaStreamAudioSourceNode
  frequencyData: Float32Array<ArrayBuffer>
  disconnect: () => void
}

export async function createAnalyserPipeline(stream: MediaStream): Promise<AnalyserPipeline> {
  const audioContext = new AudioContext()
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  const sourceNode = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()

  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.8
  analyser.minDecibels = -90
  analyser.maxDecibels = -10

  sourceNode.connect(analyser)

  return {
    audioContext,
    analyser,
    sourceNode,
    frequencyData: new Float32Array(analyser.frequencyBinCount),
    disconnect: () => {
      sourceNode.disconnect()
      analyser.disconnect()
    },
  }
}
