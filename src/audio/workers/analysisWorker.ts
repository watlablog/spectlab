import { createStftTransformer, type StftTransformer } from '../stft'
import type { FrameSize } from '../../app/types'

const ANALYSIS_SAMPLE_RATE_HZ = 48_000
const WINDOW_SECONDS = 10
const WINDOW_SAMPLES = ANALYSIS_SAMPLE_RATE_HZ * WINDOW_SECONDS
const MIN_OVERLAP_PERCENT = 0
const MAX_OVERLAP_PERCENT = 99
const SILENCE_DECIBELS = -160
const RESAMPLER_EPSILON_SEC = 1e-12

interface WorkerConfig {
  frameSize: FrameSize
  overlapPercent: number
  plotWidth: number
}

interface CaptureChunkMessage {
  type: 'capture-chunk'
  samples: Float32Array
  nativeSampleRateHz: number
  capturedSamplesNative: number
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

interface FinalizeMessage {
  type: 'finalize'
  requestId: number
}

interface SnapshotMessage {
  type: 'snapshot'
  requestId: number
}

interface ClearMessage {
  type: 'clear'
}

type WorkerRequestMessage =
  | CaptureChunkMessage
  | ConfigureMessage
  | SetPlotWidthMessage
  | FinalizeMessage
  | SnapshotMessage
  | ClearMessage

interface ColumnMessage {
  type: 'column'
  spectrum: Float32Array<ArrayBufferLike>
  capturedSamples48k: number
}

interface SnapshotResponseMessage {
  type: 'snapshot-response'
  requestId: number
  history: Float32Array<ArrayBufferLike>
  count: number
  bins: number
  pcmWindow48k: Float32Array<ArrayBufferLike>
  capturedSamples48k: number
  sampleRateHz: number
}

interface ErrorMessage {
  type: 'error'
  message: string
}

type WorkerResponseMessage = ColumnMessage | SnapshotResponseMessage | ErrorMessage

const scope = self as unknown as Worker

let config: WorkerConfig = {
  frameSize: 4096,
  overlapPercent: 75,
  plotWidth: 1,
}
let transformer: StftTransformer = createStftTransformer({ frameSize: config.frameSize })
let hopSamples = computeHopSamples(config.frameSize, config.overlapPercent)
let frameBuffer = new Float32Array(config.frameSize)
let silenceSpectrum = new Float32Array(transformer.frequencyBinCount)
silenceSpectrum.fill(SILENCE_DECIBELS)
let latestSpectrum: Float32Array = new Float32Array(silenceSpectrum)

let pcmRing = new Float32Array(WINDOW_SAMPLES)
let pcmHead = 0
let capturedSamples48k = 0

let historyData: Float32Array<ArrayBufferLike> = new Float32Array(0)
let historyCapacity = 0
let historyBins = 0
let historyHead = 0
let historyCount = 0
let columnCursorSample48k = 0
let samplesPerColumn = WINDOW_SAMPLES

let pendingSamples = new Float32Array(0)
let pendingStart = 0
let pendingLength = 0

let nativeTimeSec = 0
let nextOutputTimeSec = 0
let hasLastNativeSample = false
let lastNativeSample = 0
let lastNativeTimeSec = 0

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

function resetPendingSamples(): void {
  pendingSamples = new Float32Array(0)
  pendingStart = 0
  pendingLength = 0
}

function ensurePendingWritableSpace(additional: number): void {
  if (additional <= 0) {
    return
  }

  if (pendingSamples.length === 0) {
    pendingSamples = new Float32Array(Math.max(16_384, additional))
    pendingStart = 0
    pendingLength = 0
    return
  }

  const tailSpace = pendingSamples.length - (pendingStart + pendingLength)
  if (tailSpace >= additional) {
    return
  }

  if (pendingStart > 0) {
    pendingSamples.copyWithin(0, pendingStart, pendingStart + pendingLength)
    pendingStart = 0
    const compactedTailSpace = pendingSamples.length - pendingLength
    if (compactedTailSpace >= additional) {
      return
    }
  }

  let nextCapacity = pendingSamples.length
  while (nextCapacity - pendingLength < additional) {
    nextCapacity *= 2
  }

  const next = new Float32Array(nextCapacity)
  next.set(pendingSamples.subarray(pendingStart, pendingStart + pendingLength), 0)
  pendingSamples = next
  pendingStart = 0
}

function appendPendingSamples(samples: Float32Array): void {
  if (samples.length <= 0) {
    return
  }

  ensurePendingWritableSpace(samples.length)
  pendingSamples.set(samples, pendingStart + pendingLength)
  pendingLength += samples.length
}

function createHistoryWithSilence(capacity: number, bins: number): Float32Array<ArrayBufferLike> {
  const data = new Float32Array(capacity * bins)
  data.fill(SILENCE_DECIBELS)
  return data
}

function ensureHistoryLayout(capacity: number, bins: number): void {
  const safeCapacity = Math.max(1, Math.round(capacity))
  if (safeCapacity === historyCapacity && bins === historyBins && historyData.length === safeCapacity * bins) {
    return
  }

  const previousData = historyData
  const previousCapacity = historyCapacity
  const previousBins = historyBins
  const previousCount = historyCount
  const previousHead = historyHead

  const nextData = createHistoryWithSilence(safeCapacity, bins)
  if (previousCount > 0 && previousBins === bins && previousCapacity > 0) {
    const copyCount = Math.min(previousCount, safeCapacity)
    const sourceStart = previousCount - copyCount
    const targetStart = safeCapacity - copyCount
    for (let index = 0; index < copyCount; index += 1) {
      const sourceChronologicalIndex = sourceStart + index
      const sourceColumnIndex =
        (previousHead - previousCount + sourceChronologicalIndex + previousCapacity) % previousCapacity
      const sourceOffset = sourceColumnIndex * bins
      const targetOffset = (targetStart + index) * bins
      nextData.set(previousData.subarray(sourceOffset, sourceOffset + bins), targetOffset)
    }
  }

  historyData = nextData
  historyCapacity = safeCapacity
  historyBins = bins
  historyHead = 0
  historyCount = safeCapacity
  samplesPerColumn = WINDOW_SAMPLES / safeCapacity
  columnCursorSample48k = capturedSamples48k
}

function appendHistoryColumn(column: Float32Array): void {
  if (column.length <= 0) {
    return
  }
  ensureHistoryLayout(config.plotWidth, column.length)
  const writeOffset = historyHead * historyBins
  historyData.set(column, writeOffset)
  historyHead = (historyHead + 1) % historyCapacity
  historyCount = Math.min(historyCount + 1, historyCapacity)
}

function linearizeHistory(): Float32Array {
  if (historyCount <= 0 || historyBins <= 0 || historyCapacity <= 0) {
    return new Float32Array(0)
  }

  const linear = new Float32Array(historyCount * historyBins)
  for (let index = 0; index < historyCount; index += 1) {
    const ringIndex = (historyHead + index) % historyCapacity
    const sourceOffset = ringIndex * historyBins
    const targetOffset = index * historyBins
    linear.set(historyData.subarray(sourceOffset, sourceOffset + historyBins), targetOffset)
  }
  return linear
}

function getPcmWindowChronological(): Float32Array {
  const ordered = new Float32Array(WINDOW_SAMPLES)
  const firstChunkLength = WINDOW_SAMPLES - pcmHead
  ordered.set(pcmRing.subarray(pcmHead), 0)
  if (pcmHead > 0) {
    ordered.set(pcmRing.subarray(0, pcmHead), firstChunkLength)
  }
  return ordered
}

function emitColumn(column: Float32Array): void {
  const payload = new Float32Array(column.length)
  payload.set(column)
  const message: ColumnMessage = {
    type: 'column',
    spectrum: payload,
    capturedSamples48k,
  }
  scope.postMessage(message, [payload.buffer])
}

function emitColumnsDue(): void {
  if (historyBins <= 0 || historyCapacity <= 0 || samplesPerColumn <= 0) {
    return
  }

  while (capturedSamples48k - columnCursorSample48k >= samplesPerColumn) {
    const column = latestSpectrum.length > 0 ? latestSpectrum : silenceSpectrum
    appendHistoryColumn(column)
    columnCursorSample48k += samplesPerColumn
    emitColumn(column)
  }
}

function processPendingFrames(): void {
  if (transformer.frequencyBinCount <= 0) {
    return
  }

  while (pendingLength >= config.frameSize) {
    const frameStart = pendingStart
    frameBuffer.set(pendingSamples.subarray(frameStart, frameStart + config.frameSize))
    const transformed = transformer.transform(frameBuffer)
    latestSpectrum = new Float32Array(transformed.length)
    latestSpectrum.set(transformed)
    pendingStart += hopSamples
    pendingLength -= hopSamples

    if (pendingStart > pendingSamples.length / 2) {
      pendingSamples.copyWithin(0, pendingStart, pendingStart + pendingLength)
      pendingStart = 0
    }
  }
}

function appendResampledChunk(samples: Float32Array): void {
  if (samples.length <= 0) {
    return
  }

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index] ?? 0, -1, 1)
    pcmRing[pcmHead] = sample
    pcmHead = (pcmHead + 1) % WINDOW_SAMPLES
    capturedSamples48k += 1
  }

  appendPendingSamples(samples)
  processPendingFrames()
  emitColumnsDue()
}

function flushResamplerTail(): void {
  if (!hasLastNativeSample) {
    return
  }

  if (nextOutputTimeSec > nativeTimeSec + RESAMPLER_EPSILON_SEC) {
    return
  }

  const heldValues: number[] = []
  while (nextOutputTimeSec <= nativeTimeSec + RESAMPLER_EPSILON_SEC) {
    heldValues.push(lastNativeSample)
    nextOutputTimeSec += 1 / ANALYSIS_SAMPLE_RATE_HZ
  }

  if (heldValues.length <= 0) {
    return
  }
  appendResampledChunk(Float32Array.from(heldValues))
}

function resampleChunkTo48k(samples: Float32Array, nativeSampleRateHz: number): Float32Array {
  if (samples.length <= 0 || !Number.isFinite(nativeSampleRateHz) || nativeSampleRateHz <= 0) {
    return new Float32Array(0)
  }

  const nativeSamplePeriodSec = 1 / nativeSampleRateHz
  const outputValues: number[] = []

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index] ?? 0, -1, 1)
    const currentTimeSec = nativeTimeSec

    if (!hasLastNativeSample) {
      hasLastNativeSample = true
      lastNativeSample = sample
      lastNativeTimeSec = currentTimeSec
      nativeTimeSec += nativeSamplePeriodSec
      continue
    }

    const segmentStartSec = lastNativeTimeSec
    const segmentEndSec = currentTimeSec
    const segmentDurationSec = Math.max(RESAMPLER_EPSILON_SEC, segmentEndSec - segmentStartSec)

    while (nextOutputTimeSec <= segmentEndSec + RESAMPLER_EPSILON_SEC) {
      const ratio = clamp((nextOutputTimeSec - segmentStartSec) / segmentDurationSec, 0, 1)
      const interpolated = lastNativeSample + (sample - lastNativeSample) * ratio
      outputValues.push(interpolated)
      nextOutputTimeSec += 1 / ANALYSIS_SAMPLE_RATE_HZ
    }

    lastNativeSample = sample
    lastNativeTimeSec = currentTimeSec
    nativeTimeSec += nativeSamplePeriodSec
  }

  if (outputValues.length <= 0) {
    return new Float32Array(0)
  }

  return Float32Array.from(outputValues)
}

function rebuildHistoryFromPcmWindow(): void {
  ensureHistoryLayout(config.plotWidth, transformer.frequencyBinCount)
  historyData.fill(SILENCE_DECIBELS)
  historyHead = 0
  historyCount = historyCapacity

  if (historyBins <= 0 || historyCapacity <= 0) {
    return
  }

  const windowSamples = getPcmWindowChronological()
  const maxFrameIndex = Math.max(0, Math.ceil((windowSamples.length - 1) / hopSamples))

  for (let columnIndex = 0; columnIndex < historyCapacity; columnIndex += 1) {
    const ratio = historyCapacity > 1 ? columnIndex / (historyCapacity - 1) : 1
    const samplePosition = ratio * (windowSamples.length - 1)
    const frameIndex = clamp(Math.floor(samplePosition / hopSamples), 0, maxFrameIndex)
    const frameStart = frameIndex * hopSamples
    frameBuffer.fill(0)
    if (frameStart < windowSamples.length) {
      const frameEnd = Math.min(windowSamples.length, frameStart + config.frameSize)
      frameBuffer.set(windowSamples.subarray(frameStart, frameEnd), 0)
    }

    const transformed = transformer.transform(frameBuffer)
    historyData.set(transformed, columnIndex * historyBins)
    if (columnIndex === historyCapacity - 1) {
      latestSpectrum = new Float32Array(transformed.length)
      latestSpectrum.set(transformed)
    }
  }

  columnCursorSample48k = capturedSamples48k
}

function applyConfig(nextConfig: WorkerConfig): void {
  const normalizedConfig: WorkerConfig = {
    frameSize: nextConfig.frameSize,
    overlapPercent: normalizeOverlap(nextConfig.overlapPercent),
    plotWidth: Math.max(1, Math.round(nextConfig.plotWidth)),
  }

  const expectedBins = transformer.frequencyBinCount
  const expectedCapacity = Math.max(1, normalizedConfig.plotWidth)
  const needsHistoryRebuild =
    historyCapacity !== expectedCapacity ||
    historyBins !== expectedBins ||
    historyData.length !== expectedCapacity * expectedBins ||
    historyCount <= 0

  const frameChanged =
    normalizedConfig.frameSize !== config.frameSize || normalizedConfig.overlapPercent !== config.overlapPercent
  const widthChanged = normalizedConfig.plotWidth !== config.plotWidth
  if (!frameChanged && !widthChanged && !needsHistoryRebuild) {
    return
  }

  config = normalizedConfig
  if (frameChanged) {
    transformer = createStftTransformer({ frameSize: config.frameSize })
    hopSamples = computeHopSamples(config.frameSize, config.overlapPercent)
    frameBuffer = new Float32Array(config.frameSize)
    silenceSpectrum = new Float32Array(transformer.frequencyBinCount)
    silenceSpectrum.fill(SILENCE_DECIBELS)
    latestSpectrum = new Float32Array(silenceSpectrum)
    resetPendingSamples()
  }

  rebuildHistoryFromPcmWindow()
}

function clearAll(): void {
  pcmRing = new Float32Array(WINDOW_SAMPLES)
  pcmHead = 0
  capturedSamples48k = 0
  historyData = new Float32Array(0)
  historyCapacity = 0
  historyBins = 0
  historyHead = 0
  historyCount = 0
  columnCursorSample48k = 0
  samplesPerColumn = WINDOW_SAMPLES
  resetPendingSamples()
  hasLastNativeSample = false
  lastNativeSample = 0
  lastNativeTimeSec = 0
  nativeTimeSec = 0
  nextOutputTimeSec = 0
  latestSpectrum = new Float32Array(silenceSpectrum)
  rebuildHistoryFromPcmWindow()
}

function postSnapshotResponse(requestId: number): void {
  const history = linearizeHistory()
  const pcmWindow48k = getPcmWindowChronological()
  const response: SnapshotResponseMessage = {
    type: 'snapshot-response',
    requestId,
    history,
    count: historyCount,
    bins: historyBins,
    pcmWindow48k,
    capturedSamples48k,
    sampleRateHz: ANALYSIS_SAMPLE_RATE_HZ,
  }
  scope.postMessage(response, [history.buffer, pcmWindow48k.buffer])
}

scope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  try {
    const data = event.data
    if (!data || typeof data !== 'object') {
      return
    }

    switch (data.type) {
      case 'configure': {
        applyConfig({
          frameSize: data.frameSize,
          overlapPercent: data.overlapPercent,
          plotWidth: data.plotWidth,
        })
        break
      }
      case 'set-plot-width': {
        applyConfig({
          frameSize: config.frameSize,
          overlapPercent: config.overlapPercent,
          plotWidth: data.plotWidth,
        })
        break
      }
      case 'capture-chunk': {
        const resampled = resampleChunkTo48k(data.samples, data.nativeSampleRateHz)
        appendResampledChunk(resampled)
        break
      }
      case 'snapshot': {
        postSnapshotResponse(data.requestId)
        break
      }
      case 'finalize': {
        flushResamplerTail()
        rebuildHistoryFromPcmWindow()
        postSnapshotResponse(data.requestId)
        break
      }
      case 'clear': {
        clearAll()
        break
      }
      default:
        break
    }
  } catch (error) {
    const message: ErrorMessage = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Analysis worker failed.',
    }
    scope.postMessage(message satisfies WorkerResponseMessage)
  }
}
