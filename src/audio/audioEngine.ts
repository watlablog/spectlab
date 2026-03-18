import { createAnalyserPipeline, type AnalyserPipeline } from './analyser'
import { requestMicrophoneStream, stopMicrophoneStream } from './microphone'
import type { FrameSize, UpperFrequencyHz } from '../app/types'

export interface AudioEngineStartConfig {
  fftSize: FrameSize
  upperFrequencyHz: UpperFrequencyHz
}

export interface CaptureMetrics {
  sampleRateHz: number | null
  capturedSamplesTotal: number
  windowSamples: number
}

export interface WindowPcmSnapshot {
  samples: Float32Array
  sampleRateHz: number
  capturedSamplesTotal: number
}

export interface AudioEngine {
  start(config: AudioEngineStartConfig): Promise<void>
  stop(): Promise<void>
  getTimeDomainData(): Float32Array
  getCaptureMetrics(): CaptureMetrics
  getWindowPcmSnapshot(): WindowPcmSnapshot | null
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
  private capturedSamplesTotal = 0

  private initializeRecordedHistory(sampleRateHz: number): void {
    this.recordedSampleRateHz = sampleRateHz
    this.pcmHistoryCapacity = Math.max(1, Math.round(sampleRateHz * RECORDING_WINDOW_SECONDS))
    this.pcmHistory = new Float32Array(this.pcmHistoryCapacity)
    this.pcmHistoryHead = 0
    this.capturedSamplesTotal = 0
  }

  private appendPcmFrame(frame: Float32Array): void {
    if (this.pcmHistoryCapacity <= 0) {
      return
    }

    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index] ?? 0))
      this.pcmHistory[this.pcmHistoryHead] = sample
      this.pcmHistoryHead = (this.pcmHistoryHead + 1) % this.pcmHistoryCapacity
      this.capturedSamplesTotal += 1
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

  getCaptureMetrics(): CaptureMetrics {
    return {
      sampleRateHz: this.recordedSampleRateHz,
      capturedSamplesTotal: this.capturedSamplesTotal,
      windowSamples: this.pcmHistoryCapacity,
    }
  }

  getWindowPcmSnapshot(): WindowPcmSnapshot | null {
    if (!this.recordedSampleRateHz || this.pcmHistoryCapacity <= 0 || this.pcmHistory.length <= 0) {
      return null
    }

    const samples = new Float32Array(this.pcmHistoryCapacity)
    const firstChunkLength = this.pcmHistoryCapacity - this.pcmHistoryHead
    samples.set(this.pcmHistory.subarray(this.pcmHistoryHead), 0)
    if (this.pcmHistoryHead > 0) {
      samples.set(this.pcmHistory.subarray(0, this.pcmHistoryHead), firstChunkLength)
    }

    return {
      samples,
      sampleRateHz: this.recordedSampleRateHz,
      capturedSamplesTotal: this.capturedSamplesTotal,
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
