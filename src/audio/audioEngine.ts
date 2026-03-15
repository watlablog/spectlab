import { createAnalyserPipeline, type AnalyserPipeline } from './analyser'
import { requestMicrophoneStream, stopMicrophoneStream } from './microphone'
import type { FrameSize, UpperFrequencyHz } from '../app/types'

export interface AudioEngineStartConfig {
  fftSize: FrameSize
  upperFrequencyHz: UpperFrequencyHz
}

export interface AudioEngine {
  start(config: AudioEngineStartConfig): Promise<void>
  stop(): Promise<void>
  getTimeDomainData(): Float32Array
  getMaxFrequencyHz(): number | null
  getSampleRateHz(): number | null
}

class BrowserAudioEngine implements AudioEngine {
  private stream: MediaStream | null = null
  private pipeline: AnalyserPipeline | null = null

  async start(config: AudioEngineStartConfig): Promise<void> {
    if (this.pipeline) {
      return
    }

    this.stream = await requestMicrophoneStream()

    try {
      this.pipeline = await createAnalyserPipeline(this.stream, {
        fftSize: config.fftSize,
        upperFrequencyHz: config.upperFrequencyHz,
      })
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

  getTimeDomainData(): Float32Array {
    if (!this.pipeline) {
      return new Float32Array(0)
    }

    this.pipeline.analyser.getFloatTimeDomainData(this.pipeline.timeDomainData)
    return this.pipeline.timeDomainData
  }

  getMaxFrequencyHz(): number | null {
    if (!this.pipeline) {
      return null
    }

    return this.pipeline.audioContext.sampleRate / 2
  }

  getSampleRateHz(): number | null {
    if (!this.pipeline) {
      return null
    }

    return this.pipeline.audioContext.sampleRate
  }
}

export function createAudioEngine(): AudioEngine {
  return new BrowserAudioEngine()
}
