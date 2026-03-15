import { createAnalyserPipeline, type AnalyserPipeline } from './analyser'
import { requestMicrophoneStream, stopMicrophoneStream } from './microphone'

export interface AudioEngine {
  start(): Promise<void>
  stop(): Promise<void>
  getFrequencyData(): Float32Array
  getMaxFrequencyHz(): number | null
}

class BrowserAudioEngine implements AudioEngine {
  private stream: MediaStream | null = null
  private pipeline: AnalyserPipeline | null = null

  async start(): Promise<void> {
    if (this.pipeline) {
      return
    }

    this.stream = await requestMicrophoneStream()

    try {
      this.pipeline = await createAnalyserPipeline(this.stream)
    } catch (error) {
      stopMicrophoneStream(this.stream)
      this.stream = null
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.pipeline) {
      this.pipeline.disconnect()
      await this.pipeline.audioContext.close()
      this.pipeline = null
    }

    stopMicrophoneStream(this.stream)
    this.stream = null
  }

  getFrequencyData(): Float32Array {
    if (!this.pipeline) {
      return new Float32Array(0)
    }

    this.pipeline.analyser.getFloatFrequencyData(this.pipeline.frequencyData)
    return this.pipeline.frequencyData
  }

  getMaxFrequencyHz(): number | null {
    if (!this.pipeline) {
      return null
    }

    return this.pipeline.audioContext.sampleRate / 2
  }
}

export function createAudioEngine(): AudioEngine {
  return new BrowserAudioEngine()
}
