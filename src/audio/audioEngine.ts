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
  getRecordedPcmRange(
    startSec: number,
    endSec: number,
    windowSec: number,
  ): { samples: Float32Array; sampleRateHz: number } | null
  getMaxFrequencyHz(): number | null
  getSampleRateHz(): number | null
}

const RECORDING_WINDOW_SECONDS = 10

class BrowserAudioEngine implements AudioEngine {
  private stream: MediaStream | null = null
  private pipeline: AnalyserPipeline | null = null
  private recordedSampleRateHz: number | null = null
  private pcmHistory: Float32Array = new Float32Array(0)
  private pcmHistoryHead = 0
  private pcmHistoryCapacity = 0

  private initializeRecordedHistory(sampleRateHz: number): void {
    this.recordedSampleRateHz = sampleRateHz
    this.pcmHistoryCapacity = Math.max(1, Math.round(sampleRateHz * RECORDING_WINDOW_SECONDS))
    this.pcmHistory = new Float32Array(this.pcmHistoryCapacity)
    this.pcmHistoryHead = 0
  }

  private appendPcmFrame(frame: Float32Array): void {
    if (this.pcmHistoryCapacity <= 0) {
      return
    }

    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index] ?? 0))
      this.pcmHistory[this.pcmHistoryHead] = sample
      this.pcmHistoryHead = (this.pcmHistoryHead + 1) % this.pcmHistoryCapacity
    }
  }

  async start(config: AudioEngineStartConfig): Promise<void> {
    if (this.pipeline) {
      return
    }

    this.stream = await requestMicrophoneStream()

    try {
      this.pipeline = await createAnalyserPipeline(this.stream, {
        fftSize: config.fftSize,
        upperFrequencyHz: config.upperFrequencyHz,
        onPcmFrame: (frame) => {
          this.appendPcmFrame(frame)
        },
      })
      this.initializeRecordedHistory(this.pipeline.audioContext.sampleRate)
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

  getRecordedPcmRange(
    startSec: number,
    endSec: number,
    windowSec: number,
  ): { samples: Float32Array; sampleRateHz: number } | null {
    if (!this.recordedSampleRateHz || this.pcmHistoryCapacity <= 0 || this.pcmHistory.length <= 0) {
      return null
    }

    const safeWindowSec = Math.max(0.1, windowSec)
    const safeStartSec = Math.min(Math.max(startSec, 0), safeWindowSec)
    const safeEndSec = Math.min(
      Math.max(endSec, safeStartSec + 1 / this.recordedSampleRateHz),
      safeWindowSec,
    )

    const startIndexRaw = Math.floor((safeStartSec / safeWindowSec) * this.pcmHistoryCapacity)
    const endIndexRaw = Math.ceil((safeEndSec / safeWindowSec) * this.pcmHistoryCapacity)
    const startIndex = Math.min(Math.max(startIndexRaw, 0), this.pcmHistoryCapacity - 1)
    const endIndexExclusive = Math.min(Math.max(endIndexRaw, startIndex + 1), this.pcmHistoryCapacity)
    const sampleCount = Math.max(1, endIndexExclusive - startIndex)
    const samples = new Float32Array(sampleCount)

    for (let index = 0; index < sampleCount; index += 1) {
      const ringIndex = (this.pcmHistoryHead + startIndex + index) % this.pcmHistoryCapacity
      samples[index] = this.pcmHistory[ringIndex] ?? 0
    }

    return {
      samples,
      sampleRateHz: this.recordedSampleRateHz,
    }
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
