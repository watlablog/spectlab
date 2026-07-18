import { createStftTransformer, type StftTransformer } from '../stft'
import type { FrameSize } from '../../app/types'
import {
  cloneAudioFilterConfig,
  createBiquadCascadeProcessor,
  type AudioFilterConfig,
  type BiquadState,
} from '../filter'
import {
  buildWaveformEnvelope,
  createWaveformEnvelopeIndex,
  createWaveformEnvelopeIndexFromBlocks,
  WAVEFORM_INDEX_BASE_BLOCK_SAMPLES,
  type WaveformEnvelopeIndex,
  type WaveformEnvelopeRequest,
} from '../waveform'

const SILENCE_DECIBELS = -160
const MIN_OVERLAP_PERCENT = 0
const MAX_OVERLAP_PERCENT = 99
const FILTER_CHECKPOINT_SAMPLES = 4_096
const FILTER_YIELD_SAMPLES = 65_536

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

interface WaveformEnvelopeMessage extends WaveformEnvelopeRequest {
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
  | WaveformEnvelopeMessage
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

interface WaveformEnvelopeResponseMessage {
  type: 'waveform-envelope-response'
  requestId: number
  minValues: Float32Array
  maxValues: Float32Array
}

interface SetAudioFilterResponseMessage {
  type: 'set-audio-filter-response'
  requestId: number
}

interface AudioFilterProgressMessage {
  type: 'audio-filter-progress'
  generation: number
  percent: number
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
let originalWaveformIndex: WaveformEnvelopeIndex | null = null

let activeFilterConfigs: AudioFilterConfig[] = []
let filteredWaveformIndex: WaveformEnvelopeIndex | null = null
let filterCheckpoints: BiquadState[][] = []
let filterOperationToken = 0

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

function clearActiveFilter(): void {
  activeFilterConfigs = []
  filteredWaveformIndex = null
  filterCheckpoints = []
}

function handleLoadFile(message: LoadFileMessage): void {
  filterOperationToken += 1
  clearActiveFilter()
  loadedSamples = new Float32Array(message.samples.length)
  loadedSamples.set(message.samples, 0)
  loadedSampleRateHz = Math.max(1, message.sampleRateHz)
  loadedDurationSec = loadedSamples.length / loadedSampleRateHz
  originalWaveformIndex = createWaveformEnvelopeIndex(loadedSamples)

  const response: LoadFileResponseMessage = {
    type: 'load-file-response',
    requestId: message.requestId,
    durationSec: loadedDurationSec,
    sampleRateHz: loadedSampleRateHz,
    sampleCount: loadedSamples.length,
  }
  scope.postMessage(response)
}

function readFilteredSamples(startSample: number, endSample: number): Float32Array {
  const start = clamp(Math.floor(startSample), 0, loadedSamples.length)
  const end = clamp(Math.ceil(endSample), start, loadedSamples.length)
  if (end <= start) {
    return new Float32Array(0)
  }
  if (activeFilterConfigs.length <= 0 || filterCheckpoints.length <= 0) {
    return new Float32Array(loadedSamples.subarray(start, end))
  }

  const checkpointIndex = Math.floor(start / FILTER_CHECKPOINT_SAMPLES)
  const checkpointStart = checkpointIndex * FILTER_CHECKPOINT_SAMPLES
  const initialStates = filterCheckpoints[checkpointIndex] ?? []
  const processor = createBiquadCascadeProcessor(
    activeFilterConfigs,
    loadedSampleRateHz,
    initialStates,
  )
  const output = new Float32Array(end - start)
  for (let index = checkpointStart; index < end; index += 1) {
    const filtered = processor.processSample(loadedSamples[index] ?? 0)
    if (index >= start) {
      output[index - start] = filtered
    }
  }
  return output
}

function readFilteredRange(startSample: number, endSample: number): readonly [number, number] | null {
  const samples = readFilteredSamples(startSample, endSample)
  if (samples.length <= 0) {
    return null
  }
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const sample of samples) {
    minimum = Math.min(minimum, sample)
    maximum = Math.max(maximum, sample)
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? [minimum, maximum] : null
}

function readEffectiveSamples(startSample: number, endSample: number): Float32Array {
  return activeFilterConfigs.length > 0
    ? readFilteredSamples(startSample, endSample)
    : new Float32Array(loadedSamples.subarray(startSample, endSample))
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
  const domainMaxSec = Math.max(1e-6, loadedDurationSec)
  const timeMinSec = clamp(message.timeMinSec, 0, domainMaxSec)
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
    frameBuffer.set(readEffectiveSamples(frameStart, frameEnd), 0)
    history.set(activeTransformer.transform(frameBuffer), columnIndex * bins)
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
    scope.postMessage({
      type: 'slice-audio-response',
      requestId: message.requestId,
      samples: null,
      sampleRateHz: 0,
    } satisfies SliceAudioResponseMessage)
    return
  }

  const domainMaxSec = Math.max(1e-6, loadedDurationSec)
  const timeMinSec = clamp(message.timeMinSec, 0, domainMaxSec)
  const timeMaxSec = clamp(message.timeMaxSec, timeMinSec + 1e-6, domainMaxSec)
  const startSample = clamp(Math.floor(timeMinSec * loadedSampleRateHz), 0, loadedSamples.length - 1)
  const endSample = clamp(Math.ceil(timeMaxSec * loadedSampleRateHz), startSample + 1, loadedSamples.length)
  const samples = readEffectiveSamples(startSample, endSample)
  const response: SliceAudioResponseMessage = {
    type: 'slice-audio-response',
    requestId: message.requestId,
    samples: samples.length > 0 ? samples : null,
    sampleRateHz: loadedSampleRateHz,
  }
  if (response.samples) {
    scope.postMessage(response, [response.samples.buffer])
  } else {
    scope.postMessage(response)
  }
}

function handleWaveformEnvelope(message: WaveformEnvelopeMessage): void {
  const columnCount = Math.max(1, Math.round(message.columnCount))
  const waveformIndex = activeFilterConfigs.length > 0 ? filteredWaveformIndex : originalWaveformIndex
  if (loadedSampleRateHz <= 0 || loadedSamples.length <= 0 || !waveformIndex) {
    const minValues = new Float32Array(columnCount)
    const maxValues = new Float32Array(columnCount)
    minValues.fill(Number.NaN)
    maxValues.fill(Number.NaN)
    scope.postMessage(
      { type: 'waveform-envelope-response', requestId: message.requestId, minValues, maxValues } satisfies WaveformEnvelopeResponseMessage,
      [minValues.buffer, maxValues.buffer],
    )
    return
  }

  const domainMaxSec = Math.max(1 / loadedSampleRateHz, loadedDurationSec)
  const timeMinSec = clamp(message.timeMinSec, 0, domainMaxSec)
  const timeMaxSec = clamp(message.timeMaxSec, timeMinSec + 1 / loadedSampleRateHz, domainMaxSec)
  const startSample = clamp(Math.floor(timeMinSec * loadedSampleRateHz), 0, loadedSamples.length)
  const endSample = clamp(Math.ceil(timeMaxSec * loadedSampleRateHz), startSample + 1, loadedSamples.length)
  const envelope = buildWaveformEnvelope(startSample, endSample, 0, loadedSamples.length, columnCount, (start, end) => waveformIndex.readRange(start, end))
  scope.postMessage(
    { type: 'waveform-envelope-response', requestId: message.requestId, ...envelope } satisfies WaveformEnvelopeResponseMessage,
    [envelope.minValues.buffer, envelope.maxValues.buffer],
  )
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function postFilterProgress(generation: number, percent: number): void {
  scope.postMessage({
    type: 'audio-filter-progress',
    generation,
    percent: clamp(Math.round(percent), 0, 100),
  } satisfies AudioFilterProgressMessage)
}

async function handleSetAudioFilter(message: SetAudioFilterMessage): Promise<void> {
  const operationToken = ++filterOperationToken
  if (message.configs.length <= 0) {
    clearActiveFilter()
    postFilterProgress(message.generation, 100)
    scope.postMessage({ type: 'set-audio-filter-response', requestId: message.requestId } satisfies SetAudioFilterResponseMessage)
    return
  }
  if (loadedSamples.length <= 0 || loadedSampleRateHz <= 0) {
    throw new Error('No audio is available to filter.')
  }

  const configs = message.configs.map(cloneAudioFilterConfig)
  const processor = createBiquadCascadeProcessor(configs, loadedSampleRateHz)
  const blockCount = Math.ceil(loadedSamples.length / WAVEFORM_INDEX_BASE_BLOCK_SAMPLES)
  const baseMinValues = new Float32Array(blockCount)
  const baseMaxValues = new Float32Array(blockCount)
  baseMinValues.fill(Number.POSITIVE_INFINITY)
  baseMaxValues.fill(Number.NEGATIVE_INFINITY)
  const checkpoints: BiquadState[][] = []
  postFilterProgress(message.generation, 0)

  for (let index = 0; index < loadedSamples.length; index += 1) {
    if (index % FILTER_CHECKPOINT_SAMPLES === 0) {
      checkpoints[index / FILTER_CHECKPOINT_SAMPLES] = processor.getStates()
    }
    const sample = processor.processSample(loadedSamples[index] ?? 0)
    const blockIndex = Math.floor(index / WAVEFORM_INDEX_BASE_BLOCK_SAMPLES)
    baseMinValues[blockIndex] = Math.min(baseMinValues[blockIndex] ?? Number.POSITIVE_INFINITY, sample)
    baseMaxValues[blockIndex] = Math.max(baseMaxValues[blockIndex] ?? Number.NEGATIVE_INFINITY, sample)

    if ((index + 1) % FILTER_YIELD_SAMPLES === 0) {
      postFilterProgress(message.generation, ((index + 1) / loadedSamples.length) * 100)
      await yieldToEventLoop()
      if (operationToken !== filterOperationToken) {
        scope.postMessage({ type: 'set-audio-filter-response', requestId: message.requestId } satisfies SetAudioFilterResponseMessage)
        return
      }
    }
  }

  if (operationToken !== filterOperationToken) {
    scope.postMessage({ type: 'set-audio-filter-response', requestId: message.requestId } satisfies SetAudioFilterResponseMessage)
    return
  }
  activeFilterConfigs = configs
  filterCheckpoints = checkpoints
  filteredWaveformIndex = createWaveformEnvelopeIndexFromBlocks(
    loadedSamples.length,
    baseMinValues,
    baseMaxValues,
    readFilteredRange,
  )
  postFilterProgress(message.generation, 100)
  scope.postMessage({ type: 'set-audio-filter-response', requestId: message.requestId } satisfies SetAudioFilterResponseMessage)
}

function clearLoadedAudio(): void {
  filterOperationToken += 1
  loadedSamples = new Float32Array(0)
  loadedSampleRateHz = 0
  loadedDurationSec = 0
  originalWaveformIndex = null
  clearActiveFilter()
}

scope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const data = event.data
  if (!data || typeof data !== 'object') {
    return
  }
  try {
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
      case 'waveform-envelope':
        handleWaveformEnvelope(data)
        break
      case 'set-audio-filter':
        void handleSetAudioFilter(data).catch((error) => postError(error instanceof Error ? error.message : 'Filter processing failed.', data.requestId))
        break
      case 'clear':
        clearLoadedAudio()
        break
    }
  } catch (error) {
    postError(error instanceof Error ? error.message : 'File analysis worker failed.', 'requestId' in data ? data.requestId : undefined)
  }
}
