import { createStftTransformer, type StftTransformer } from '../stft'
import type { FrameSize } from '../../app/types'

const SILENCE_DECIBELS = -160
const MIN_OVERLAP_PERCENT = 0
const MAX_OVERLAP_PERCENT = 99

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

interface ClearMessage {
  type: 'clear'
}

type WorkerRequestMessage = LoadFileMessage | RenderWindowMessage | SliceAudioMessage | ClearMessage

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

interface ErrorMessage {
  type: 'error'
  requestId?: number
  message: string
}

const scope = self as unknown as Worker

let loadedSamples = new Float32Array(0)
let loadedSampleRateHz = 0
let loadedDurationSec = 0

let transformer: StftTransformer | null = null
let transformerFrameSize: FrameSize | null = null
let frameBuffer = new Float32Array(0)

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeOverlap(overlapPercent: number): number {
  return clamp(Math.round(overlapPercent), MIN_OVERLAP_PERCENT, MAX_OVERLAP_PERCENT)
}

function computeHopSamples(frameSize: FrameSize, overlapPercent: number): number {
  const normalized = normalizeOverlap(overlapPercent)
  return Math.max(1, Math.round(frameSize * (1 - normalized / 100)))
}

function ensureTransformer(frameSize: FrameSize): StftTransformer {
  if (transformer && transformerFrameSize === frameSize) {
    return transformer
  }
  transformer = createStftTransformer({ frameSize })
  transformerFrameSize = frameSize
  frameBuffer = new Float32Array(frameSize)
  return transformer
}

function postError(message: string, requestId?: number): void {
  const payload: ErrorMessage = { type: 'error', message }
  if (typeof requestId === 'number') {
    payload.requestId = requestId
  }
  scope.postMessage(payload)
}

function handleLoadFile(message: LoadFileMessage): void {
  loadedSamples = new Float32Array(message.samples.length)
  loadedSamples.set(message.samples, 0)
  loadedSampleRateHz = Math.max(1, message.sampleRateHz)
  loadedDurationSec = loadedSamples.length / loadedSampleRateHz

  const response: LoadFileResponseMessage = {
    type: 'load-file-response',
    requestId: message.requestId,
    durationSec: loadedDurationSec,
    sampleRateHz: loadedSampleRateHz,
    sampleCount: loadedSamples.length,
  }
  scope.postMessage(response)
}

function handleRenderWindow(message: RenderWindowMessage): void {
  if (loadedSampleRateHz <= 0 || loadedSamples.length <= 0) {
    const emptyResponse: RenderWindowResponseMessage = {
      type: 'render-window-response',
      requestId: message.requestId,
      history: new Float32Array(0),
      count: 0,
      bins: 0,
    }
    scope.postMessage(emptyResponse)
    return
  }

  const activeTransformer = ensureTransformer(message.frameSize)
  const bins = activeTransformer.frequencyBinCount
  const columnCount = Math.max(1, Math.round(message.plotWidth))
  const history = new Float32Array(columnCount * bins)
  history.fill(SILENCE_DECIBELS)

  const domainMinSec = 0
  const domainMaxSec = Math.max(domainMinSec + 1e-6, loadedDurationSec)
  const timeMinSec = clamp(message.timeMinSec, domainMinSec, domainMaxSec)
  const timeMaxSec = clamp(message.timeMaxSec, timeMinSec + 1e-6, domainMaxSec)

  const startSample = clamp(Math.floor(timeMinSec * loadedSampleRateHz), 0, Math.max(loadedSamples.length - 1, 0))
  const endSample = clamp(Math.ceil(timeMaxSec * loadedSampleRateHz), startSample + 1, loadedSamples.length)
  const selectedSamples = Math.max(1, endSample - startSample)
  const hopSamples = computeHopSamples(message.frameSize, message.overlapPercent)
  const maxFrameStart = Math.max(0, loadedSamples.length - message.frameSize)

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const ratio = columnCount > 1 ? columnIndex / (columnCount - 1) : 0
    const targetSample = startSample + ratio * (selectedSamples - 1)
    const quantizedCenter = Math.round(targetSample / hopSamples) * hopSamples
    const frameStart = clamp(quantizedCenter - Math.floor(message.frameSize / 2), 0, maxFrameStart)
    const frameEnd = Math.min(loadedSamples.length, frameStart + message.frameSize)

    frameBuffer.fill(0)
    frameBuffer.set(loadedSamples.subarray(frameStart, frameEnd), 0)
    const transformed = activeTransformer.transform(frameBuffer)
    history.set(transformed, columnIndex * bins)
  }

  const response: RenderWindowResponseMessage = {
    type: 'render-window-response',
    requestId: message.requestId,
    history,
    count: columnCount,
    bins,
  }
  scope.postMessage(response, [history.buffer])
}

function handleSliceAudio(message: SliceAudioMessage): void {
  if (loadedSampleRateHz <= 0 || loadedSamples.length <= 0) {
    const emptyResponse: SliceAudioResponseMessage = {
      type: 'slice-audio-response',
      requestId: message.requestId,
      samples: null,
      sampleRateHz: 0,
    }
    scope.postMessage(emptyResponse)
    return
  }

  const domainMinSec = 0
  const domainMaxSec = Math.max(domainMinSec + 1e-6, loadedDurationSec)
  const timeMinSec = clamp(message.timeMinSec, domainMinSec, domainMaxSec)
  const timeMaxSec = clamp(message.timeMaxSec, timeMinSec + 1e-6, domainMaxSec)

  const startSample = clamp(Math.floor(timeMinSec * loadedSampleRateHz), 0, loadedSamples.length - 1)
  const endSample = clamp(Math.ceil(timeMaxSec * loadedSampleRateHz), startSample + 1, loadedSamples.length)

  const sliced = new Float32Array(Math.max(0, endSample - startSample))
  if (sliced.length > 0) {
    sliced.set(loadedSamples.subarray(startSample, endSample), 0)
  }

  const response: SliceAudioResponseMessage = {
    type: 'slice-audio-response',
    requestId: message.requestId,
    samples: sliced.length > 0 ? sliced : null,
    sampleRateHz: loadedSampleRateHz,
  }

  if (response.samples) {
    scope.postMessage(response, [response.samples.buffer])
    return
  }
  scope.postMessage(response)
}

function clearLoadedAudio(): void {
  loadedSamples = new Float32Array(0)
  loadedSampleRateHz = 0
  loadedDurationSec = 0
}

scope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  try {
    const data = event.data
    if (!data || typeof data !== 'object') {
      return
    }

    switch (data.type) {
      case 'load-file':
        handleLoadFile(data)
        break
      case 'render-window':
        handleRenderWindow(data)
        break
      case 'slice-audio':
        handleSliceAudio(data)
        break
      case 'clear':
        clearLoadedAudio()
        break
      default:
        break
    }
  } catch (error) {
    postError(error instanceof Error ? error.message : 'File analysis worker failed.')
  }
}
