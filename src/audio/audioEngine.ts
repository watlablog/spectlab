import {
  createAnalyserPipeline,
  type AnalyserPipeline,
  type CaptureChunk as PipelineCaptureChunk,
  type CaptureWindowSnapshot,
} from './analyser'
import { requestMicrophoneStream, stopMicrophoneStream } from './microphone'
import type { FrameSize, UpperFrequencyHz } from '../app/types'

export interface AudioEngineStartConfig {
  fftSize: FrameSize
  upperFrequencyHz: UpperFrequencyHz
}

export interface CaptureMetrics {
  nativeSampleRateHz: number | null
  capturedSamplesNative: number
}

export interface CaptureChunk {
  samples: Float32Array
  nativeSampleRateHz: number
  capturedSamplesNative: number
}

export interface WindowPcmSnapshot {
  samples: Float32Array
  sampleRateHz: number
  capturedSamplesNative: number
}

export interface AudioEngine {
  start(config: AudioEngineStartConfig): Promise<void>
  stop(): Promise<void>
  clearCapturedData(): void
  subscribeCaptureChunk(cb: (chunk: CaptureChunk) => void): () => void
  requestWindowSnapshot(): Promise<WindowPcmSnapshot | null>
  getCaptureMetrics(): CaptureMetrics
  getMaxFrequencyHz(): number | null
}

const RECORDING_WINDOW_SECONDS = 10

class BrowserAudioEngine implements AudioEngine {
  private stream: MediaStream | null = null
  private pipeline: AnalyserPipeline | null = null
  private recordedSampleRateHz: number | null = null
  private pcmHistory: Float32Array = new Float32Array(0)
  private pcmHistoryHead = 0
  private pcmHistoryCapacity = 0
  private capturedSamplesNative = 0
  private readonly captureChunkSubscribers = new Set<(chunk: CaptureChunk) => void>()

  private initializeRecordedHistory(sampleRateHz: number): void {
    this.recordedSampleRateHz = sampleRateHz
    this.pcmHistoryCapacity = Math.max(1, Math.round(sampleRateHz * RECORDING_WINDOW_SECONDS))
    this.pcmHistory = new Float32Array(this.pcmHistoryCapacity)
    this.pcmHistoryHead = 0
    this.capturedSamplesNative = 0
  }

  private appendPcmFrame(frame: Float32Array): void {
    if (this.pcmHistoryCapacity <= 0) {
      return
    }

    for (let index = 0; index < frame.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, frame[index] ?? 0))
      this.pcmHistory[this.pcmHistoryHead] = sample
      this.pcmHistoryHead = (this.pcmHistoryHead + 1) % this.pcmHistoryCapacity
      this.capturedSamplesNative += 1
    }
  }

  private appendCaptureChunk(chunk: PipelineCaptureChunk): void {
    if (!Number.isFinite(chunk.nativeSampleRateHz) || chunk.nativeSampleRateHz <= 0) {
      return
    }

    const needsHistoryReset =
      !this.recordedSampleRateHz ||
      this.pcmHistoryCapacity <= 0 ||
      Math.abs(chunk.nativeSampleRateHz - this.recordedSampleRateHz) > 1e-6
    if (needsHistoryReset) {
      this.initializeRecordedHistory(chunk.nativeSampleRateHz)
    }

    this.appendPcmFrame(chunk.samples)
    const payload: CaptureChunk = {
      samples: chunk.samples,
      nativeSampleRateHz: chunk.nativeSampleRateHz,
      capturedSamplesNative: chunk.capturedSamplesNative,
    }
    for (const subscriber of this.captureChunkSubscribers) {
      subscriber(payload)
    }
  }

  private snapshotFromLocalRing(): WindowPcmSnapshot | null {
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
      capturedSamplesNative: this.capturedSamplesNative,
    }
  }

  private mergeSnapshot(snapshot: CaptureWindowSnapshot): void {
    if (!Number.isFinite(snapshot.sampleRateHz) || snapshot.sampleRateHz <= 0) {
      return
    }

    const needsHistoryReset =
      !this.recordedSampleRateHz ||
      this.pcmHistoryCapacity <= 0 ||
      Math.abs(snapshot.sampleRateHz - this.recordedSampleRateHz) > 1e-6
    if (needsHistoryReset) {
      this.initializeRecordedHistory(snapshot.sampleRateHz)
    }

    const missingSamples = Math.max(0, snapshot.capturedSamplesNative - this.capturedSamplesNative)
    if (missingSamples <= 0) {
      return
    }

    const startIndex = Math.max(0, snapshot.samples.length - missingSamples)
    this.appendPcmFrame(snapshot.samples.subarray(startIndex))
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
        onCaptureChunk: (chunk) => {
          this.appendCaptureChunk(chunk)
        },
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

  clearCapturedData(): void {
    if (this.pcmHistoryCapacity <= 0) {
      this.recordedSampleRateHz = null
      this.pcmHistory = new Float32Array(0)
      this.pcmHistoryHead = 0
      this.capturedSamplesNative = 0
      return
    }

    this.pcmHistory.fill(0)
    this.pcmHistoryHead = 0
    this.capturedSamplesNative = 0
  }

  subscribeCaptureChunk(cb: (chunk: CaptureChunk) => void): () => void {
    this.captureChunkSubscribers.add(cb)
    return () => {
      this.captureChunkSubscribers.delete(cb)
    }
  }

  async requestWindowSnapshot(): Promise<WindowPcmSnapshot | null> {
    if (!this.pipeline) {
      return this.snapshotFromLocalRing()
    }

    const snapshot = await this.pipeline.requestWindowSnapshot()
    if (snapshot) {
      this.mergeSnapshot(snapshot)
    }
    return this.snapshotFromLocalRing()
  }

  getCaptureMetrics(): CaptureMetrics {
    return {
      nativeSampleRateHz: this.recordedSampleRateHz,
      capturedSamplesNative: this.capturedSamplesNative,
    }
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
