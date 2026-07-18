import type { FrameSize } from '../app/types'
import FileAnalysisWorker from './workers/fileAnalysisWorker?worker'
import type { AudioFilterConfig, AudioFilterProgress } from './filter'
import type { WaveformEnvelopeRequest, WaveformEnvelopeResult } from './waveform'

export interface FileLoadResult {
  durationSec: number
  sampleRateHz: number
  sampleCount: number
}

export interface FileRenderParams {
  timeMinSec: number
  timeMaxSec: number
  plotWidth: number
  frameSize: FrameSize
  overlapPercent: number
}

export interface FileRenderResult {
  history: Float32Array
  count: number
  bins: number
}

export interface FileSliceResult {
  samples: Float32Array
  sampleRateHz: number
}

interface LoadFileMessage {
  type: 'load-file'
  requestId: number
  samples: Float32Array
  sampleRateHz: number
}

interface RenderWindowMessage {
  type: 'render-window'
  requestId: number
  timeMinSec: number
  timeMaxSec: number
  plotWidth: number
  frameSize: FrameSize
  overlapPercent: number
}

interface SliceAudioMessage {
  type: 'slice-audio'
  requestId: number
  timeMinSec: number
  timeMaxSec: number
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

interface ClearMessage {
  type: 'clear'
}

type WorkerRequestMessage =
  | LoadFileMessage
  | RenderWindowMessage
  | SliceAudioMessage
  | WaveformEnvelopeRequestMessage
  | SetAudioFilterMessage
  | ClearMessage

interface LoadFileResponseMessage {
  type: 'load-file-response'
  requestId: number
  durationSec: number
  sampleRateHz: number
  sampleCount: number
}

interface RenderWindowResponseMessage {
  type: 'render-window-response'
  requestId: number
  history: Float32Array
  count: number
  bins: number
}

interface SliceAudioResponseMessage {
  type: 'slice-audio-response'
  requestId: number
  samples: Float32Array | null
  sampleRateHz: number
}

interface WaveformEnvelopeResponseMessage extends WaveformEnvelopeResult {
  type: 'waveform-envelope-response'
  requestId: number
}

interface SetAudioFilterResponseMessage {
  type: 'set-audio-filter-response'
  requestId: number
}

interface AudioFilterProgressMessage extends AudioFilterProgress {
  type: 'audio-filter-progress'
}

interface ErrorMessage {
  type: 'error'
  requestId?: number
  message: string
}

type WorkerResponseMessage =
  | LoadFileResponseMessage
  | RenderWindowResponseMessage
  | SliceAudioResponseMessage
  | WaveformEnvelopeResponseMessage
  | SetAudioFilterResponseMessage
  | AudioFilterProgressMessage
  | ErrorMessage

type PendingRequestKind = 'load' | 'render' | 'slice' | 'waveform' | 'filter'

interface PendingRequest<T> {
  kind: PendingRequestKind
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeoutId: number
}

export interface FileAnalysisService {
  loadFile(samples: Float32Array, sampleRateHz: number): Promise<FileLoadResult>
  renderWindow(params: FileRenderParams): Promise<FileRenderResult>
  sliceAudio(timeMinSec: number, timeMaxSec: number): Promise<FileSliceResult | null>
  requestWaveformEnvelope(request: WaveformEnvelopeRequest): Promise<WaveformEnvelopeResult>
  setAudioFilters(configs: AudioFilterConfig[], generation: number): Promise<void>
  subscribeAudioFilterProgress(cb: (progress: AudioFilterProgress) => void): () => void
  clear(): void
  dispose(): void
}

class WorkerFileAnalysisService implements FileAnalysisService {
  private readonly worker: Worker
  private readonly pendingRequests = new Map<number, PendingRequest<unknown>>()
  private readonly filterProgressSubscribers = new Set<(progress: AudioFilterProgress) => void>()
  private requestId = 1

  constructor() {
    this.worker = new FileAnalysisWorker()
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponseMessage>) => {
      const data = event.data
      if (!data || typeof data !== 'object') {
        return
      }

      if (data.type === 'error') {
        if (typeof data.requestId === 'number') {
          const pending = this.pendingRequests.get(data.requestId)
          if (!pending) {
            return
          }
          this.pendingRequests.delete(data.requestId)
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(data.message))
          return
        }

        for (const [requestId, pending] of this.pendingRequests) {
          this.pendingRequests.delete(requestId)
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error(data.message))
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

      const pending = this.pendingRequests.get(data.requestId)
      if (!pending) {
        return
      }
      this.pendingRequests.delete(data.requestId)
      window.clearTimeout(pending.timeoutId)

      if (data.type === 'load-file-response' && pending.kind === 'load') {
        pending.resolve({
          durationSec: data.durationSec,
          sampleRateHz: data.sampleRateHz,
          sampleCount: data.sampleCount,
        } satisfies FileLoadResult)
        return
      }

      if (data.type === 'render-window-response' && pending.kind === 'render') {
        pending.resolve({
          history: data.history,
          count: data.count,
          bins: data.bins,
        } satisfies FileRenderResult)
        return
      }

      if (data.type === 'slice-audio-response' && pending.kind === 'slice') {
        if (!data.samples || data.samples.length <= 0) {
          pending.resolve(null)
          return
        }
        pending.resolve({
          samples: data.samples,
          sampleRateHz: data.sampleRateHz,
        } satisfies FileSliceResult)
        return
      }

      if (data.type === 'waveform-envelope-response' && pending.kind === 'waveform') {
        pending.resolve({
          minValues: data.minValues,
          maxValues: data.maxValues,
        } satisfies WaveformEnvelopeResult)
        return
      }

      if (data.type === 'set-audio-filter-response' && pending.kind === 'filter') {
        pending.resolve(undefined)
      }
    })

    this.worker.addEventListener('error', (event) => {
      const message = event.message || 'File analysis worker crashed.'
      for (const [requestId, pending] of this.pendingRequests) {
        this.pendingRequests.delete(requestId)
        window.clearTimeout(pending.timeoutId)
        pending.reject(new Error(message))
      }
    })
  }

  async loadFile(samples: Float32Array, sampleRateHz: number): Promise<FileLoadResult> {
    const payload = new Float32Array(samples)
    return this.request<FileLoadResult>(
      'load',
      {
        type: 'load-file',
        requestId: this.allocateRequestId(),
        samples: payload,
        sampleRateHz,
      },
      [payload.buffer],
      30_000,
    )
  }

  async renderWindow(params: FileRenderParams): Promise<FileRenderResult> {
    return this.request<FileRenderResult>(
      'render',
      {
        type: 'render-window',
        requestId: this.allocateRequestId(),
        timeMinSec: params.timeMinSec,
        timeMaxSec: params.timeMaxSec,
        plotWidth: Math.max(1, Math.round(params.plotWidth)),
        frameSize: params.frameSize,
        overlapPercent: params.overlapPercent,
      },
      [],
      15_000,
    )
  }

  async sliceAudio(timeMinSec: number, timeMaxSec: number): Promise<FileSliceResult | null> {
    return this.request<FileSliceResult | null>(
      'slice',
      {
        type: 'slice-audio',
        requestId: this.allocateRequestId(),
        timeMinSec,
        timeMaxSec,
      },
      [],
      10_000,
    )
  }

  async requestWaveformEnvelope(request: WaveformEnvelopeRequest): Promise<WaveformEnvelopeResult> {
    return this.request<WaveformEnvelopeResult>(
      'waveform',
      {
        type: 'waveform-envelope',
        requestId: this.allocateRequestId(),
        timeMinSec: request.timeMinSec,
        timeMaxSec: request.timeMaxSec,
        columnCount: Math.max(1, Math.round(request.columnCount)),
      },
      [],
      10_000,
    )
  }

  async setAudioFilters(configs: AudioFilterConfig[], generation: number): Promise<void> {
    return this.request<void>(
      'filter',
      {
        type: 'set-audio-filter',
        requestId: this.allocateRequestId(),
        generation,
        configs,
      },
      [],
      120_000,
    )
  }

  subscribeAudioFilterProgress(cb: (progress: AudioFilterProgress) => void): () => void {
    this.filterProgressSubscribers.add(cb)
    return () => {
      this.filterProgressSubscribers.delete(cb)
    }
  }

  clear(): void {
    this.postMessage({ type: 'clear' })
  }

  dispose(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId)
      window.clearTimeout(pending.timeoutId)
      pending.reject(new Error('File analysis worker disposed.'))
    }
    this.filterProgressSubscribers.clear()
    this.worker.terminate()
  }

  private request<T>(
    kind: PendingRequestKind,
    message: WorkerRequestMessage & { requestId: number },
    transfer: Transferable[],
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = this.pendingRequests.get(message.requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(message.requestId)
        pending.reject(new Error(`File analysis worker timeout (${kind}).`))
      }, timeoutMs)

      this.pendingRequests.set(message.requestId, {
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      })
      this.postMessage(message, transfer)
    })
  }

  private allocateRequestId(): number {
    const id = this.requestId
    this.requestId += 1
    return id
  }

  private postMessage(message: WorkerRequestMessage, transfer: Transferable[] = []): void {
    if (transfer.length > 0) {
      this.worker.postMessage(message, transfer)
      return
    }
    this.worker.postMessage(message)
  }
}

export function createFileAnalysisService(): FileAnalysisService {
  return new WorkerFileAnalysisService()
}
