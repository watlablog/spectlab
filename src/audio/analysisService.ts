import type { FrameSize } from '../app/types'
import AnalysisWorker from './workers/analysisWorker?worker'
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

type RequestMessage =
  | ConfigureMessage
  | SetPlotWidthMessage
  | CaptureChunkMessage
  | SnapshotRequestMessage
  | FinalizeRequestMessage
  | ClearMessage

interface ColumnMessage {
  type: 'column'
  spectrum: Float32Array
  capturedSamples48k: number
}

interface SnapshotResponseMessage {
  type: 'snapshot-response'
  requestId: number
  history: Float32Array
  count: number
  bins: number
  pcmWindow48k: Float32Array
  capturedSamples48k: number
  sampleRateHz: number
}

interface ErrorMessage {
  type: 'error'
  message: string
}

type ResponseMessage = ColumnMessage | SnapshotResponseMessage | ErrorMessage

interface PendingRequest {
  resolve: (snapshot: AnalysisSnapshot) => void
  reject: (error: Error) => void
  timeoutId: number
}

export interface AnalysisService {
  start(config: AnalysisStartConfig): void
  setPlotWidth(plotWidth: number): void
  pushCaptureChunk(chunk: AnalysisCaptureChunk): void
  subscribeColumns(cb: (column: AnalysisColumn) => void): () => void
  requestHistorySnapshot(): Promise<AnalysisSnapshot>
  stopAndFinalize(): Promise<AnalysisSnapshot>
  clear(): void
  getSampleRateHz(): number
  dispose(): void
}

class WorkerAnalysisService implements AnalysisService {
  private readonly worker: Worker
  private readonly columnSubscribers = new Set<(column: AnalysisColumn) => void>()
  private readonly pendingRequests = new Map<number, PendingRequest>()
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

      if (data.type === 'snapshot-response') {
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

      if (data.type === 'error') {
        for (const [, pending] of this.pendingRequests) {
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(data.message))
        }
        this.pendingRequests.clear()
      }
    })
    this.worker.addEventListener('error', (event) => {
      const message = event.message || 'Analysis worker crashed.'
      for (const [, pending] of this.pendingRequests) {
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error(message))
      }
      this.pendingRequests.clear()
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
    this.columnSubscribers.clear()
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
