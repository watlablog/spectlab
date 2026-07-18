import type { FrameSize } from '../app/types'
import AnalysisWorker from './workers/analysisWorker?worker'
import type { AudioFilterConfig, AudioFilterProgress } from './filter'
import type { WaveformEnvelopeRequest, WaveformEnvelopeResult } from './waveform'
const ANALYSIS_SAMPLE_RATE_HZ = 48_000

export interface AnalysisCaptureChunk {
  samples: Float32Array
  nativeSampleRateHz: number
  capturedSamplesNative: number
}

export interface AnalysisColumn {
  spectrum: Float32Array
  capturedSamples48k: number
}

export interface AnalysisSnapshot {
  spectrogramHistory: Float32Array
  count: number
  bins: number
  pcmWindow48k: Float32Array
  capturedSamples48k: number
  sampleRateHz: number
}

export interface AnalysisStartConfig {
  frameSize: FrameSize
  overlapPercent: number
  plotWidth: number
}

interface ConfigureMessage {
  type: 'configure'
  frameSize: FrameSize
  overlapPercent: number
  plotWidth: number
}

interface SetPlotWidthMessage {
  type: 'set-plot-width'
  plotWidth: number
}

interface CaptureChunkMessage {
  type: 'capture-chunk'
  samples: Float32Array
  nativeSampleRateHz: number
  capturedSamplesNative: number
}

interface SnapshotRequestMessage {
  type: 'snapshot'
  requestId: number
}

interface FinalizeRequestMessage {
  type: 'finalize'
  requestId: number
}

interface ClearMessage {
  type: 'clear'
}

interface WaveformEnvelopeRequestMessage extends WaveformEnvelopeRequest {
  type: 'waveform-envelope'
  requestId: number
}

interface SetAudioFilterMessage {
  type: 'set-audio-filter'
  requestId: number
  generation: number
  configs: AudioFilterConfig[]
}

type RequestMessage =
  | ConfigureMessage
  | SetPlotWidthMessage
  | CaptureChunkMessage
  | SnapshotRequestMessage
  | FinalizeRequestMessage
  | WaveformEnvelopeRequestMessage
  | SetAudioFilterMessage
  | ClearMessage

interface ColumnMessage {
  type: 'column'
  spectrum: Float32Array
  capturedSamples48k: number
}

interface SnapshotResponseMessage {
  type: 'snapshot-response' | 'set-audio-filter-response'
  requestId: number
  history: Float32Array
  count: number
  bins: number
  pcmWindow48k: Float32Array
  capturedSamples48k: number
  sampleRateHz: number
}

interface AudioFilterProgressMessage extends AudioFilterProgress {
  type: 'audio-filter-progress'
}

interface ErrorMessage {
  type: 'error'
  message: string
}

interface WaveformEnvelopeResponseMessage extends WaveformEnvelopeResult {
  type: 'waveform-envelope-response'
  requestId: number
}

type ResponseMessage =
  | ColumnMessage
  | SnapshotResponseMessage
  | WaveformEnvelopeResponseMessage
  | AudioFilterProgressMessage
  | ErrorMessage

interface PendingRequest {
  resolve: (snapshot: AnalysisSnapshot) => void
  reject: (error: Error) => void
  timeoutId: number
}

interface PendingWaveformRequest {
  resolve: (result: WaveformEnvelopeResult) => void
  reject: (error: Error) => void
  timeoutId: number
}

export interface AnalysisService {
  start(config: AnalysisStartConfig): void
  setPlotWidth(plotWidth: number): void
  pushCaptureChunk(chunk: AnalysisCaptureChunk): void
  subscribeColumns(cb: (column: AnalysisColumn) => void): () => void
  requestHistorySnapshot(): Promise<AnalysisSnapshot>
  requestWaveformEnvelope(request: WaveformEnvelopeRequest): Promise<WaveformEnvelopeResult>
  setAudioFilters(configs: AudioFilterConfig[], generation: number): Promise<AnalysisSnapshot>
  subscribeAudioFilterProgress(cb: (progress: AudioFilterProgress) => void): () => void
  stopAndFinalize(): Promise<AnalysisSnapshot>
  clear(): void
  getSampleRateHz(): number
  dispose(): void
}

class WorkerAnalysisService implements AnalysisService {
  private readonly worker: Worker
  private readonly columnSubscribers = new Set<(column: AnalysisColumn) => void>()
  private readonly filterProgressSubscribers = new Set<(progress: AudioFilterProgress) => void>()
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly pendingWaveformRequests = new Map<number, PendingWaveformRequest>()
  private requestId = 1

  constructor() {
    this.worker = new AnalysisWorker()
    this.worker.addEventListener('message', (event: MessageEvent<ResponseMessage>) => {
      const data = event.data
      if (!data || typeof data !== 'object') {
        return
      }

      if (data.type === 'column') {
        const payload = {
          spectrum: data.spectrum,
          capturedSamples48k: data.capturedSamples48k,
        } satisfies AnalysisColumn
        for (const subscriber of this.columnSubscribers) {
          subscriber(payload)
        }
        return
      }

      if (data.type === 'audio-filter-progress') {
        const progress = { generation: data.generation, percent: data.percent }
        for (const subscriber of this.filterProgressSubscribers) {
          subscriber(progress)
        }
        return
      }

      if (data.type === 'snapshot-response' || data.type === 'set-audio-filter-response') {
        const pending = this.pendingRequests.get(data.requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(data.requestId)
        window.clearTimeout(pending.timeoutId)
        pending.resolve({
          spectrogramHistory: data.history,
          count: data.count,
          bins: data.bins,
          pcmWindow48k: data.pcmWindow48k,
          capturedSamples48k: data.capturedSamples48k,
          sampleRateHz: data.sampleRateHz,
        })
        return
      }

      if (data.type === 'waveform-envelope-response') {
        const pending = this.pendingWaveformRequests.get(data.requestId)
        if (!pending) {
          return
        }
        this.pendingWaveformRequests.delete(data.requestId)
        window.clearTimeout(pending.timeoutId)
        pending.resolve({
          minValues: data.minValues,
          maxValues: data.maxValues,
        })
        return
      }

      if (data.type === 'error') {
        for (const [, pending] of this.pendingRequests) {
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(data.message))
        }
        this.pendingRequests.clear()
        for (const [, pending] of this.pendingWaveformRequests) {
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(data.message))
        }
        this.pendingWaveformRequests.clear()
      }
    })
    this.worker.addEventListener('error', (event) => {
      const message = event.message || 'Analysis worker crashed.'
      for (const [, pending] of this.pendingRequests) {
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error(message))
      }
      this.pendingRequests.clear()
      for (const [, pending] of this.pendingWaveformRequests) {
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error(message))
      }
      this.pendingWaveformRequests.clear()
    })
  }

  start(config: AnalysisStartConfig): void {
    this.postMessage({
      type: 'configure',
      frameSize: config.frameSize,
      overlapPercent: config.overlapPercent,
      plotWidth: Math.max(1, Math.round(config.plotWidth)),
    })
  }

  setPlotWidth(plotWidth: number): void {
    this.postMessage({
      type: 'set-plot-width',
      plotWidth: Math.max(1, Math.round(plotWidth)),
    })
  }

  pushCaptureChunk(chunk: AnalysisCaptureChunk): void {
    const payload = new Float32Array(chunk.samples)
    this.postMessage(
      {
        type: 'capture-chunk',
        samples: payload,
        nativeSampleRateHz: chunk.nativeSampleRateHz,
        capturedSamplesNative: chunk.capturedSamplesNative,
      },
      [payload.buffer],
    )
  }

  subscribeColumns(cb: (column: AnalysisColumn) => void): () => void {
    this.columnSubscribers.add(cb)
    return () => {
      this.columnSubscribers.delete(cb)
    }
  }

  requestHistorySnapshot(): Promise<AnalysisSnapshot> {
    return this.requestSnapshot('snapshot')
  }

  requestWaveformEnvelope(request: WaveformEnvelopeRequest): Promise<WaveformEnvelopeResult> {
    return new Promise<WaveformEnvelopeResult>((resolve, reject) => {
      const requestId = this.requestId
      this.requestId += 1
      const timeoutId = window.setTimeout(() => {
        const pending = this.pendingWaveformRequests.get(requestId)
        if (!pending) {
          return
        }
        this.pendingWaveformRequests.delete(requestId)
        pending.reject(new Error('Analysis worker timeout (waveform-envelope).'))
      }, 3000)
      this.pendingWaveformRequests.set(requestId, { resolve, reject, timeoutId })
      this.postMessage({
        type: 'waveform-envelope',
        requestId,
        timeMinSec: request.timeMinSec,
        timeMaxSec: request.timeMaxSec,
        columnCount: Math.max(1, Math.round(request.columnCount)),
      })
    })
  }

  setAudioFilters(configs: AudioFilterConfig[], generation: number): Promise<AnalysisSnapshot> {
    return new Promise<AnalysisSnapshot>((resolve, reject) => {
      const requestId = this.requestId
      this.requestId += 1
      const timeoutId = window.setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(requestId)
        pending.reject(new Error('Analysis worker timeout (set-audio-filter).'))
      }, 30_000)
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId })
      this.postMessage({ type: 'set-audio-filter', requestId, generation, configs })
    })
  }

  subscribeAudioFilterProgress(cb: (progress: AudioFilterProgress) => void): () => void {
    this.filterProgressSubscribers.add(cb)
    return () => {
      this.filterProgressSubscribers.delete(cb)
    }
  }

  stopAndFinalize(): Promise<AnalysisSnapshot> {
    return this.requestSnapshot('finalize')
  }

  clear(): void {
    this.postMessage({ type: 'clear' })
  }

  getSampleRateHz(): number {
    return ANALYSIS_SAMPLE_RATE_HZ
  }

  dispose(): void {
    for (const [, pending] of this.pendingRequests) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(new Error('Analysis worker disposed.'))
    }
    this.pendingRequests.clear()
    for (const [, pending] of this.pendingWaveformRequests) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(new Error('Analysis worker disposed.'))
    }
    this.pendingWaveformRequests.clear()
    this.columnSubscribers.clear()
    this.filterProgressSubscribers.clear()
    this.worker.terminate()
  }

  private requestSnapshot(type: 'snapshot' | 'finalize'): Promise<AnalysisSnapshot> {
    return new Promise<AnalysisSnapshot>((resolve, reject) => {
      const requestId = this.requestId
      this.requestId += 1
      const timeoutMs = type === 'finalize' ? 8000 : 3000
      const timeoutId = window.setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(requestId)
        pending.reject(new Error(`Analysis worker timeout (${type}).`))
      }, timeoutMs)
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId })
      this.postMessage({ type, requestId })
    })
  }

  private postMessage(message: RequestMessage, transfer: Transferable[] = []): void {
    if (transfer.length > 0) {
      this.worker.postMessage(message, transfer)
      return
    }
    this.worker.postMessage(message)
  }
}

export function createAnalysisService(): AnalysisService {
  return new WorkerAnalysisService()
}
