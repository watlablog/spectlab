import { createAudioEngine, type CaptureChunk } from '../audio/audioEngine'
import { createAnalysisService, type AnalysisSnapshot } from '../audio/analysisService'
import { createFileAnalysisService } from '../audio/fileAnalysisService'
import { createAppStateStore } from './state'
import {
  createRenderer,
  type AxisRenderConfig,
  type CursorOverlayConfig,
  type PlotMetrics,
} from '../render/canvas'
import {
  buildColormapGradient,
  COLORMAP_PRESETS,
  DEFAULT_COLORMAP_ID,
  getColormapLabel,
  isColormapId,
  type ColormapId,
} from '../render/colorMap'
import { renderControlsView } from '../ui/controlsView'
import { getUIElements } from '../ui/dom'
import { isMicrophonePermissionError, toErrorMessage } from '../utils/errors'
import { Circle, createElement as createLucideElement, Download, Eraser, Play, Square, Upload } from 'lucide'
import type { AppState, FrameSize, UpperFrequencyHz } from './types'

const SPECTROGRAM_WINDOW_SECONDS = 10
const TIME_DOMAIN_MIN_SEC = 0
const TIME_DOMAIN_MAX_SEC = 10
const FREQUENCY_DOMAIN_MIN_HZ = 0
const DEFAULT_MAX_FREQUENCY_HZ = 22050
const FREQUENCY_TICK_COUNT = 6
const TIME_TICK_COUNT = 6
const RECORDING_PATH = '/recording'
const FREQUENCY_STEP_HZ = 1
const MIN_RANGE_GAP_HZ = 1
const TIME_STEP_SEC = 0.1
const MIN_TIME_GAP_SEC = 0.1
const FRAME_SIZE_OPTIONS: FrameSize[] = [512, 1024, 2048, 4096, 8192]
const UPPER_FREQUENCY_OPTIONS: UpperFrequencyHz[] = [5000, 10000, 20000]
const DEFAULT_ANALYSIS_FRAME_SIZE: FrameSize = 4096
const DEFAULT_ANALYSIS_OVERLAP_PERCENT = 75
const DEFAULT_ANALYSIS_UPPER_FREQUENCY_HZ: UpperFrequencyHz = 10000
const MIN_OVERLAP_PERCENT = 0
const MAX_OVERLAP_PERCENT = 99
const DEFAULT_DECIBEL_MIN = -20
const DEFAULT_DECIBEL_MAX = 80
const DECIBEL_INPUT_MIN = -100
const DECIBEL_INPUT_MAX = 200
const DECIBEL_STEP = 1
const MIN_DECIBEL_GAP = 1
const DECIBEL_TICK_COUNT = 6
const SILENCE_DECIBELS = -160
const MOBILE_BREAKPOINT_PX = 760
const MAX_ANALYSIS_BACKLOG_HOPS = 24
const MAX_COLUMN_BACKLOG_FACTOR = 4
const MAX_PENDING_ANALYSIS_COLUMNS = 256
const MAX_DYNAMIC_COLUMNS_PER_FRAME = 256
const STAGE_DEGRADE_LEVEL1_FRAME_MS = 24
const STAGE_DEGRADE_LEVEL2_FRAME_MS = 32
const STAGE_DEGRADE_REQUIRED_FRAMES = 120
const STAGE_UPGRADE_FRAME_MS = 18
const STAGE_UPGRADE_REQUIRED_FRAMES = 300
const FFT_PANEL_DOMAIN_MIN_HZ = 0
const FFT_PANEL_TICK_COUNT = 6
const FFT_PANEL_SINGLE_CURSOR_DEFAULT_SEC = 10
const FFT_PROFILE_REFRESH_INTERVAL_MS = 50
const CURSOR_NEAR_TAP_THRESHOLD_DESKTOP_PX = 20
const CURSOR_NEAR_TAP_THRESHOLD_MOBILE_PX = 28
const FFT_CURVE_TENSION = 1
const FILE_RENDER_THROTTLE_MS = 100
const MAX_FILE_DURATION_SECONDS = 30 * 60
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
const NO_REAL_DATA_RANGE_MESSAGE = '選択範囲に実データがありません。'

interface QualityProfile {
  renderFps: number
  analysisHz: number
  dprCap: number
  maxColumnsPerFrame: number
  maxAnalysisStepsPerFrame: number
}

const MOBILE_QUALITY_PROFILES: QualityProfile[] = [
  {
    renderFps: 30,
    analysisHz: 30,
    dprCap: 1.5,
    maxColumnsPerFrame: 2,
    maxAnalysisStepsPerFrame: 8,
  },
  {
    renderFps: 24,
    analysisHz: 24,
    dprCap: 1.25,
    maxColumnsPerFrame: 2,
    maxAnalysisStepsPerFrame: 8,
  },
  {
    renderFps: 15,
    analysisHz: 15,
    dprCap: 1.0,
    maxColumnsPerFrame: 2,
    maxAnalysisStepsPerFrame: 8,
  },
]

const DESKTOP_QUALITY_PROFILE: QualityProfile = {
  renderFps: 60,
  analysisHz: 60,
  dprCap: 2.0,
  maxColumnsPerFrame: 4,
  maxAnalysisStepsPerFrame: 16,
}

type DragHandle = 'min' | 'max'

interface FrequencyRange {
  minHz: number
  maxHz: number
}

interface FrequencyHistoryRing {
  data: Float32Array
  capacity: number
  bins: number
  count: number
  head: number
}

interface TimelineSyncState {
  sampleRateHz: number
  windowSamples: number
  plotWidth: number
  capturedSamples: number
}

interface DisplayedAudioSlice {
  samples: Float32Array
  sampleRateHz: number
  startSample: number
  endSample: number
}

interface LiveDataWindow {
  hasData: boolean
  dataStartSample: number
  dataEndSample: number
  dataStartSec: number
  dataEndSec: number
  capturedDurationSec: number
}

interface DecodedAudioFile {
  samples: Float32Array
  sampleRateHz: number
  durationSec: number
  fileName: string
}

type FftCursorMode = 'single' | 'average'
type FftCursorDragHandle = 'single' | 'min' | 'max'

interface FftCursorState {
  mode: FftCursorMode
  singleSec: number
  rangeMinSec: number
  rangeMaxSec: number
  activeDragHandle: FftCursorDragHandle | null
  activePointerId: number | null
  lastFallbackNoticeKey: string | null
}

type FftComputationSource = 'frame' | 'average-frame' | 'slice-fallback'

interface FftProfileState {
  spectrumDb: Float32Array
  source: FftComputationSource
  updatedAtMs: number
}

interface CursorCandidate {
  handle: FftCursorDragHandle
  seconds: number
  visible: boolean
  distancePx: number
  distanceSec: number
}

interface FftFrequencyBounds {
  nyquistHz: number
  minHz: number
  maxHz: number
  spanHz: number
}

function normalizeRecordingRoute(): void {
  if (window.location.pathname === RECORDING_PATH) {
    return
  }

  const normalizedUrl = `${RECORDING_PATH}${window.location.search}${window.location.hash}`
  window.history.replaceState({}, '', normalizedUrl)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function traceCatmullRomThroughPoints(
  context: CanvasRenderingContext2D,
  startX: number,
  stepX: number,
  yValues: Float32Array,
): void {
  const pointCount = yValues.length
  if (pointCount <= 0) {
    return
  }

  const tension = clamp(FFT_CURVE_TENSION, 0, 1)
  context.beginPath()
  context.moveTo(startX, yValues[0] ?? 0)

  if (pointCount === 1) {
    return
  }

  if (pointCount === 2) {
    context.lineTo(startX + stepX, yValues[1] ?? yValues[0] ?? 0)
    return
  }

  for (let index = 0; index < pointCount - 1; index += 1) {
    const prevIndex = Math.max(0, index - 1)
    const nextIndex = index + 1
    const nextNextIndex = Math.min(pointCount - 1, index + 2)

    const x0 = startX + prevIndex * stepX
    const x1 = startX + index * stepX
    const x2 = startX + nextIndex * stepX
    const x3 = startX + nextNextIndex * stepX

    const y0 = yValues[prevIndex] ?? yValues[index] ?? 0
    const y1 = yValues[index] ?? 0
    const y2 = yValues[nextIndex] ?? y1
    const y3 = yValues[nextNextIndex] ?? y2

    const control1X = x1 + ((x2 - x0) * tension) / 6
    const control1Y = y1 + ((y2 - y0) * tension) / 6
    const control2X = x2 - ((x3 - x1) * tension) / 6
    const control2Y = y2 - ((y3 - y1) * tension) / 6

    context.bezierCurveTo(control1X, control1Y, control2X, control2Y, x2, y2)
  }
}

function isMobileViewport(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
  }
  return window.innerWidth <= MOBILE_BREAKPOINT_PX
}

function roundToFrequencyStep(value: number): number {
  return Math.round(value / FREQUENCY_STEP_HZ) * FREQUENCY_STEP_HZ
}

function roundToDecibelStep(value: number): number {
  return Math.round(value / DECIBEL_STEP) * DECIBEL_STEP
}

function normalizeOverlapPercent(value: number): number {
  return clamp(Math.round(value), MIN_OVERLAP_PERCENT, MAX_OVERLAP_PERCENT)
}

function parseFiniteNumberInput(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return parsed
}

function parseFrameSizeInput(value: string): FrameSize | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const rounded = Math.round(parsed)
  if (!FRAME_SIZE_OPTIONS.includes(rounded as FrameSize)) {
    return null
  }

  return rounded as FrameSize
}

function parseUpperFrequencyInput(value: string): UpperFrequencyHz | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const rounded = Math.round(parsed)
  if (!UPPER_FREQUENCY_OPTIONS.includes(rounded as UpperFrequencyHz)) {
    return null
  }

  return rounded as UpperFrequencyHz
}

function parseOverlapInput(value: string): number | null {
  const parsed = parseFiniteNumberInput(value)
  if (parsed === null) {
    return null
  }
  return Math.round(parsed)
}

function parseDecibelInput(value: string): number | null {
  const parsed = parseFiniteNumberInput(value)
  if (parsed === null) {
    return null
  }
  return roundToDecibelStep(parsed)
}

function parseFrequencyInput(value: string): number | null {
  const parsed = parseFiniteNumberInput(value)
  if (parsed === null) {
    return null
  }
  return roundToFrequencyStep(parsed)
}

function parseTimeInput(value: string): number | null {
  const parsed = parseFiniteNumberInput(value)
  if (parsed === null) {
    return null
  }
  return Math.round(parsed / TIME_STEP_SEC) * TIME_STEP_SEC
}

function formatByStep(value: number, step: number): string {
  if (step >= 1) {
    return String(Math.round(value))
  }
  const decimals = Math.max(0, Math.round(Math.log10(1 / step)))
  return value.toFixed(decimals)
}

function showNumericInputAlert(label: string): void {
  window.alert(`${label} は数値で入力してください。`)
}

function showInputRangeAlert(label: string, min: number, max: number, step: number): void {
  window.alert(
    `${label} の入力範囲は ${formatByStep(min, step)} から ${formatByStep(max, step)} です。`,
  )
}

function normalizeDecibelRange(minDb: number, maxDb: number): { minDb: number; maxDb: number } {
  let nextMinDb = clamp(minDb, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX - MIN_DECIBEL_GAP)
  let nextMaxDb = clamp(maxDb, DECIBEL_INPUT_MIN + MIN_DECIBEL_GAP, DECIBEL_INPUT_MAX)

  if (nextMaxDb - nextMinDb < MIN_DECIBEL_GAP) {
    nextMaxDb = clamp(nextMinDb + MIN_DECIBEL_GAP, DECIBEL_INPUT_MIN + MIN_DECIBEL_GAP, DECIBEL_INPUT_MAX)
    nextMinDb = clamp(nextMaxDb - MIN_DECIBEL_GAP, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX - MIN_DECIBEL_GAP)
  }

  return {
    minDb: Math.round(nextMinDb),
    maxDb: Math.round(nextMaxDb),
  }
}

function normalizeFrequencyRange(
  minHz: number,
  maxHz: number,
  domainMinHz: number,
  domainMaxHz: number,
): FrequencyRange {
  const safeDomainMaxHz = Math.max(domainMinHz + MIN_RANGE_GAP_HZ, domainMaxHz)

  let nextMinHz = clamp(roundToFrequencyStep(minHz), domainMinHz, safeDomainMaxHz - MIN_RANGE_GAP_HZ)
  let nextMaxHz = clamp(roundToFrequencyStep(maxHz), domainMinHz + MIN_RANGE_GAP_HZ, safeDomainMaxHz)

  if (nextMaxHz - nextMinHz < MIN_RANGE_GAP_HZ) {
    nextMaxHz = clamp(nextMinHz + MIN_RANGE_GAP_HZ, domainMinHz + MIN_RANGE_GAP_HZ, safeDomainMaxHz)
    nextMinHz = clamp(nextMaxHz - MIN_RANGE_GAP_HZ, domainMinHz, safeDomainMaxHz - MIN_RANGE_GAP_HZ)
  }

  return {
    minHz: nextMinHz,
    maxHz: nextMaxHz,
  }
}

function normalizeTimeRange(
  minSec: number,
  maxSec: number,
  domainMinSec: number,
  domainMaxSec: number,
): { minSec: number; maxSec: number } {
  const safeDomainMaxSec = Math.max(domainMinSec + MIN_TIME_GAP_SEC, domainMaxSec)

  let nextMinSec = clamp(minSec, domainMinSec, safeDomainMaxSec - MIN_TIME_GAP_SEC)
  let nextMaxSec = clamp(maxSec, domainMinSec + MIN_TIME_GAP_SEC, safeDomainMaxSec)

  if (nextMaxSec - nextMinSec < MIN_TIME_GAP_SEC) {
    nextMaxSec = clamp(nextMinSec + MIN_TIME_GAP_SEC, domainMinSec + MIN_TIME_GAP_SEC, safeDomainMaxSec)
    nextMinSec = clamp(nextMaxSec - MIN_TIME_GAP_SEC, domainMinSec, safeDomainMaxSec - MIN_TIME_GAP_SEC)
  }

  return {
    minSec: Math.round(nextMinSec / TIME_STEP_SEC) * TIME_STEP_SEC,
    maxSec: Math.round(nextMaxSec / TIME_STEP_SEC) * TIME_STEP_SEC,
  }
}

function toSliderRatio(hz: number, domainMinHz: number, domainMaxHz: number): number {
  const safeDomainMaxHz = Math.max(domainMinHz + MIN_RANGE_GAP_HZ, domainMaxHz)
  const spanHz = safeDomainMaxHz - domainMinHz
  if (spanHz <= 0) {
    return 0
  }

  return clamp((safeDomainMaxHz - hz) / spanHz, 0, 1)
}

function fromSliderRatio(ratio: number, domainMinHz: number, domainMaxHz: number): number {
  const safeDomainMaxHz = Math.max(domainMinHz + MIN_RANGE_GAP_HZ, domainMaxHz)
  const spanHz = safeDomainMaxHz - domainMinHz
  const boundedRatio = clamp(ratio, 0, 1)
  return roundToFrequencyStep(safeDomainMaxHz - boundedRatio * spanHz)
}

function toDecibelSliderRatio(decibels: number, domainMinDb: number, domainMaxDb: number): number {
  const safeDomainMaxDb = Math.max(domainMinDb + MIN_DECIBEL_GAP, domainMaxDb)
  const spanDb = safeDomainMaxDb - domainMinDb
  if (spanDb <= 0) {
    return 0
  }

  return clamp((safeDomainMaxDb - decibels) / spanDb, 0, 1)
}

function fromDecibelSliderRatio(ratio: number, domainMinDb: number, domainMaxDb: number): number {
  const safeDomainMaxDb = Math.max(domainMinDb + MIN_DECIBEL_GAP, domainMaxDb)
  const spanDb = safeDomainMaxDb - domainMinDb
  const boundedRatio = clamp(ratio, 0, 1)
  return roundToDecibelStep(safeDomainMaxDb - boundedRatio * spanDb)
}

function toTimeSliderRatio(seconds: number, domainMinSec: number, domainMaxSec: number): number {
  const safeDomainMaxSec = Math.max(domainMinSec + MIN_TIME_GAP_SEC, domainMaxSec)
  const spanSec = safeDomainMaxSec - domainMinSec
  if (spanSec <= 0) {
    return 0
  }

  return clamp((seconds - domainMinSec) / spanSec, 0, 1)
}

function fromTimeSliderRatio(ratio: number, domainMinSec: number, domainMaxSec: number): number {
  const safeDomainMaxSec = Math.max(domainMinSec + MIN_TIME_GAP_SEC, domainMaxSec)
  const spanSec = safeDomainMaxSec - domainMinSec
  const boundedRatio = clamp(ratio, 0, 1)
  return Math.round((domainMinSec + boundedRatio * spanSec) / TIME_STEP_SEC) * TIME_STEP_SEC
}

function buildTimeTicks(minSec: number, maxSec: number): number[] {
  const spanSec = Math.max(MIN_TIME_GAP_SEC, maxSec - minSec)
  const ticks: number[] = []

  for (let index = 0; index < TIME_TICK_COUNT; index += 1) {
    const ratio = index / Math.max(TIME_TICK_COUNT - 1, 1)
    ticks.push(Math.round((ratio * spanSec) / TIME_STEP_SEC) * TIME_STEP_SEC)
  }

  return ticks
}

async function decodeAudioFileToMono(file: File): Promise<DecodedAudioFile> {
  const buffer = await file.arrayBuffer()
  const context = new AudioContext()

  try {
    const decoded = await context.decodeAudioData(buffer.slice(0))
    const sampleRateHz = decoded.sampleRate
    const frameLength = decoded.length
    const channelCount = Math.max(1, decoded.numberOfChannels)
    const durationSec = decoded.duration

    const mono = new Float32Array(frameLength)
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = decoded.getChannelData(channel)
      for (let index = 0; index < frameLength; index += 1) {
        mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / channelCount
      }
    }

    return {
      samples: mono,
      sampleRateHz,
      durationSec,
      fileName: file.name,
    }
  } finally {
    await context.close().catch(() => undefined)
  }
}

function encodeWavMono16(samples: Float32Array, sampleRateHz: number): Blob {
  if (samples.length <= 0) {
    throw new Error('保存できる音声データがありません。')
  }

  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error('無効なサンプリング周波数です。')
  }

  const channelCount = 1
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const byteRate = Math.round(sampleRateHz) * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, Math.round(sampleRateHz), true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = clamp(samples[index] ?? 0, -1, 1)
    const pcmValue = normalized < 0 ? Math.round(normalized * 0x8000) : Math.round(normalized * 0x7fff)
    view.setInt16(offset, pcmValue, true)
    offset += bytesPerSample
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function buildAudioFilename(now: Date, timeMinSec: number, timeMaxSec: number): string {
  const pad2 = (value: number): string => String(value).padStart(2, '0')
  const year = String(now.getFullYear())
  const month = pad2(now.getMonth() + 1)
  const day = pad2(now.getDate())
  const hour = pad2(now.getHours())
  const minute = pad2(now.getMinutes())
  const second = pad2(now.getSeconds())
  const startLabel = timeMinSec.toFixed(1)
  const endLabel = timeMaxSec.toFixed(1)
  return `spectlab_${year}${month}${day}_${hour}${minute}${second}_t${startLabel}-${endLabel}s.wav`
}

export function bootstrapApp(): void {
  normalizeRecordingRoute()
  const elements = getUIElements()
  const stateStore = createAppStateStore({
    analysisSource: 'live',
    isLoadingFile: false,
    loadedAudioName: null,
    loadedAudioDurationSec: null,
    currentSampleRateHz: null,
    analysisFrameSize: DEFAULT_ANALYSIS_FRAME_SIZE,
    analysisOverlapPercent: DEFAULT_ANALYSIS_OVERLAP_PERCENT,
    analysisUpperFrequencyHz: DEFAULT_ANALYSIS_UPPER_FREQUENCY_HZ,
    colormapId: DEFAULT_COLORMAP_ID,
    decibelMin: DEFAULT_DECIBEL_MIN,
    decibelMax: DEFAULT_DECIBEL_MAX,
    frequencyDomainMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyDomainMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
    frequencyMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
    timeDomainMinSec: TIME_DOMAIN_MIN_SEC,
    timeDomainMaxSec: TIME_DOMAIN_MAX_SEC,
    timeMinSec: TIME_DOMAIN_MIN_SEC,
    timeMaxSec: TIME_DOMAIN_MAX_SEC,
  })
  const audioEngine = createAudioEngine()
  const analysisService = createAnalysisService()
  const fileAnalysisService = createFileAnalysisService()
  const renderer = createRenderer()
  renderer.init(elements.canvas)
  const fftCanvasCtx = elements.fftCanvas.getContext('2d')
  if (!fftCanvasCtx) {
    throw new Error('Failed to initialize FFT canvas context.')
  }

  let captureChunkUnsubscribe: (() => void) | null = null
  let analysisColumnsUnsubscribe: (() => void) | null = null
  let frameId: number | null = null
  let lastAnimationTimestamp: number | null = null
  let timelineSyncState: TimelineSyncState = {
    sampleRateHz: analysisService.getSampleRateHz(),
    windowSamples: Math.round(analysisService.getSampleRateHz() * SPECTROGRAM_WINDOW_SECONDS),
    plotWidth: 1,
    capturedSamples: 0,
  }
  let renderGateAccumulatorSeconds = 0
  let freqDragHandle: DragHandle | null = null
  let freqDragPointerId: number | null = null
  let dbDragHandle: DragHandle | null = null
  let dbDragPointerId: number | null = null
  let timeDragHandle: DragHandle | null = null
  let timeDragPointerId: number | null = null
  let projectionBuffer = new Float32Array(0)
  let historyLinearBuffer = new Float32Array(0)
  let frequencyHistoryRing: FrequencyHistoryRing = {
    data: new Float32Array(0),
    capacity: 0,
    bins: 0,
    count: 0,
    head: 0,
  }
  let lastRenderedRangeMinHz: number | null = null
  let lastRenderedRangeMaxHz: number | null = null
  let lastRenderedDecibelMin: number | null = null
  let lastRenderedDecibelMax: number | null = null
  let lastRenderedColormapId: ColormapId | null = null
  let lastRenderedTimeMinSec: number | null = null
  let lastRenderedTimeMaxSec: number | null = null
  let lastRenderedFrameSize: FrameSize | null = null
  let lastRenderedOverlapPercent: number | null = null
  let lastRenderedUpperFrequencyHz: UpperFrequencyHz | null = null
  let activeQualityStageIndex = 0
  let frameTimeEmaMs = 1000 / DESKTOP_QUALITY_PROFILE.renderFps
  let aboveLevel1FrameCount = 0
  let aboveLevel2FrameCount = 0
  let belowRecoveryFrameCount = 0
  let resizeObserver: ResizeObserver | null = null
  let pendingColumnQueue: Float32Array[] = []
  let renderHistoryRafId: number | null = null
  let isHistoryRenderRequested = false
  let historyResyncInFlight = false
  let fileRenderSequence = 0
  let fileRenderThrottleTimer: number | null = null
  let fileRenderInFlight = false
  let pendingFileRenderAfterCurrent = false
  let latestPcmWindow48k: Float32Array<ArrayBufferLike> = new Float32Array(0)
  let latestCapturedSamples48k = 0
  let conservativeMode = false
  let playbackContext: AudioContext | null = null
  let playbackSourceNode: AudioBufferSourceNode | null = null
  let playbackProgressRafId: number | null = null
  let playbackStartTimeSec = 0
  let playbackDurationSec = 0
  let fftRefreshTimeoutId: number | null = null
  let fftLastRefreshAtMs = 0
  let fftProfileState: FftProfileState | null = null
  let fftProfileAccumulator = new Float32Array(0)
  let fftPlotCursorHz: number | null = null
  let fftPlotCursorPointerId: number | null = null
  let isColormapPopoverOpen = false
  const colormapOptionButtons = new Map<ColormapId, HTMLButtonElement>()
  const fftCursorState: FftCursorState = {
    mode: 'single',
    singleSec: FFT_PANEL_SINGLE_CURSOR_DEFAULT_SEC,
    rangeMinSec: FFT_PANEL_SINGLE_CURSOR_DEFAULT_SEC,
    rangeMaxSec: FFT_PANEL_SINGLE_CURSOR_DEFAULT_SEC,
    activeDragHandle: null,
    activePointerId: null,
    lastFallbackNoticeKey: null,
  }
  const axisConfig: AxisRenderConfig = {
    timeWindowSec: SPECTROGRAM_WINDOW_SECONDS,
    timeLabelOffsetSec: 0,
    frequencyMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
    xTicksSec: [0, 2, 4, 6, 8, 10],
    yTickCount: FREQUENCY_TICK_COUNT,
  }
  const fftNumberFormatter = new Intl.NumberFormat('en-US')
  let fftPendingAllowFallbackNotice = false

  const setColormapPopoverOpen = (open: boolean, focusActiveOption = false): void => {
    isColormapPopoverOpen = open
    elements.colormapPopover.hidden = !open
    elements.dbColorbar.setAttribute('aria-expanded', String(open))

    if (open && focusActiveOption) {
      window.requestAnimationFrame(() => {
        colormapOptionButtons.get(stateStore.getState().colormapId)?.focus()
      })
    }
  }

  const buildColormapPopover = (): void => {
    elements.colormapPopover.replaceChildren()
    colormapOptionButtons.clear()

    let activeCategory: string | null = null
    for (const preset of COLORMAP_PRESETS) {
      if (preset.category !== activeCategory) {
        activeCategory = preset.category
        const title = document.createElement('p')
        title.className = 'colormap-group-title'
        title.textContent = preset.category
        elements.colormapPopover.append(title)
      }

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'colormap-option'
      button.dataset.colormapId = preset.id
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', 'false')

      const swatch = document.createElement('span')
      swatch.className = 'colormap-swatch'
      swatch.style.background = buildColormapGradient(preset.id, 'to right')
      swatch.setAttribute('aria-hidden', 'true')

      const label = document.createElement('span')
      label.className = 'colormap-label'
      label.textContent = preset.label

      button.append(swatch, label)
      button.addEventListener('click', () => {
        const nextColormapId = button.dataset.colormapId ?? ''
        if (!isColormapId(nextColormapId)) {
          return
        }

        stateStore.setState({ colormapId: nextColormapId })
        setColormapPopoverOpen(false)
        elements.dbColorbar.focus()
      })

      colormapOptionButtons.set(preset.id, button)
      elements.colormapPopover.append(button)
    }
  }

  const renderColormapControl = (state: AppState): void => {
    elements.dbColorbar.style.background = buildColormapGradient(state.colormapId, 'to bottom')
    elements.dbColorbar.setAttribute(
      'aria-label',
      `Colormap: ${getColormapLabel(state.colormapId)}. Open colormap selector`,
    )
    elements.dbColorbar.setAttribute('aria-expanded', String(isColormapPopoverOpen))

    for (const [colormapId, button] of colormapOptionButtons) {
      const active = colormapId === state.colormapId
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', String(active))
    }
  }

  const getMinimumCursorRangeSec = (state: AppState): number => {
    const sampleRateHz = Math.max(1, timelineSyncState.sampleRateHz)
    return state.analysisFrameSize / sampleRateHz
  }

  const getTimeDomainSpanSec = (state: AppState): number => {
    return Math.max(MIN_TIME_GAP_SEC, state.timeDomainMaxSec - state.timeDomainMinSec)
  }

  const clampCursorSeconds = (seconds: number, state: AppState): number => {
    return clamp(seconds, state.timeDomainMinSec, state.timeDomainMaxSec)
  }

  const getLiveDataWindow = (): LiveDataWindow => {
    const sampleRateHz = Math.max(1, timelineSyncState.sampleRateHz)
    const windowSamples = Math.max(0, latestPcmWindow48k.length)
    const capturedSamples = clamp(
      Math.min(windowSamples, Math.floor(latestCapturedSamples48k)),
      0,
      windowSamples,
    )
    const hasData = windowSamples > 0 && capturedSamples > 0
    const dataEndSample = windowSamples
    const dataStartSample = Math.max(0, dataEndSample - capturedSamples)

    return {
      hasData,
      dataStartSample,
      dataEndSample,
      dataStartSec: dataStartSample / sampleRateHz,
      dataEndSec: dataEndSample / sampleRateHz,
      capturedDurationSec: capturedSamples / sampleRateHz,
    }
  }

  const getSpectrogramCursorBoundsSec = (
    state: AppState,
  ): { hasData: boolean; minSec: number; maxSec: number } => {
    if (state.analysisSource !== 'live') {
      return {
        hasData: true,
        minSec: state.timeDomainMinSec,
        maxSec: state.timeDomainMaxSec,
      }
    }

    const liveDataWindow = getLiveDataWindow()
    if (!liveDataWindow.hasData) {
      return {
        hasData: false,
        minSec: state.timeDomainMinSec,
        maxSec: state.timeDomainMinSec,
      }
    }

    const minSec = clamp(liveDataWindow.dataStartSec, state.timeDomainMinSec, state.timeDomainMaxSec)
    const maxSec = clamp(liveDataWindow.dataEndSec, minSec, state.timeDomainMaxSec)
    return {
      hasData: maxSec > minSec,
      minSec,
      maxSec,
    }
  }

  const clampSpectrogramCursorSecToLiveData = (seconds: number, state: AppState): number => {
    const bounds = getSpectrogramCursorBoundsSec(state)
    if (!bounds.hasData) {
      return clampCursorSeconds(seconds, state)
    }
    return clamp(seconds, bounds.minSec, bounds.maxSec)
  }

  const intersectSelectionWithLiveData = (
    selectionStartSample: number,
    selectionEndSample: number,
    liveWindow: LiveDataWindow,
  ): { start: number; end: number } | null => {
    if (!liveWindow.hasData) {
      return null
    }

    const start = Math.max(selectionStartSample, liveWindow.dataStartSample)
    const end = Math.min(selectionEndSample, liveWindow.dataEndSample)
    if (end <= start) {
      return null
    }

    return { start, end }
  }

  const clampFftCursorsToActiveDomain = (): void => {
    const state = stateStore.getState()
    fftCursorState.singleSec = clampSpectrogramCursorSecToLiveData(fftCursorState.singleSec, state)
    fftCursorState.rangeMinSec = clampSpectrogramCursorSecToLiveData(fftCursorState.rangeMinSec, state)
    fftCursorState.rangeMaxSec = clampSpectrogramCursorSecToLiveData(fftCursorState.rangeMaxSec, state)
  }

  const showFallbackNoticeIfNeeded = (minRangeSec: number, reasonKey: string, allowNotice: boolean): void => {
    if (!allowNotice) {
      return
    }

    const noticeKey = `${reasonKey}:${minRangeSec.toFixed(3)}`
    if (fftCursorState.lastFallbackNoticeKey === noticeKey) {
      return
    }

    fftCursorState.lastFallbackNoticeKey = noticeKey
    window.alert(
      `Selected range is shorter than one analysis frame. Using spectrogram-slice FFT.\nMinimum cursor range: ${minRangeSec.toFixed(
        3,
      )} s`,
    )
  }

  const ensureAverageCursorRange = (
    state: AppState,
    singleSec: number,
    minimumRangeSec: number,
  ): { minSec: number; maxSec: number; impossible: boolean } => {
    const cursorBounds = getSpectrogramCursorBoundsSec(state)
    const safeSingleSec = clampSpectrogramCursorSecToLiveData(singleSec, state)
    if (!cursorBounds.hasData) {
      return {
        minSec: safeSingleSec,
        maxSec: safeSingleSec,
        impossible: true,
      }
    }

    const domainMinSec = cursorBounds.minSec
    const domainMaxSec = cursorBounds.maxSec
    const domainSpanSec = Math.max(0, domainMaxSec - domainMinSec)
    if (!Number.isFinite(minimumRangeSec) || minimumRangeSec > domainSpanSec) {
      return {
        minSec: safeSingleSec,
        maxSec: safeSingleSec,
        impossible: true,
      }
    }

    const halfRangeSec = minimumRangeSec / 2
    let minSec = safeSingleSec - halfRangeSec
    let maxSec = safeSingleSec + halfRangeSec
    if (minSec < domainMinSec) {
      maxSec += domainMinSec - minSec
      minSec = domainMinSec
    }
    if (maxSec > domainMaxSec) {
      minSec -= maxSec - domainMaxSec
      maxSec = domainMaxSec
    }
    minSec = clampSpectrogramCursorSecToLiveData(minSec, state)
    maxSec = clampSpectrogramCursorSecToLiveData(maxSec, state)
    return {
      minSec,
      maxSec,
      impossible: false,
    }
  }

  const resolveTimelineIndexForAbsoluteSec = (state: AppState, seconds: number): number => {
    const capacity = frequencyHistoryRing.capacity
    if (capacity <= 1) {
      return 0
    }
    const domainSpanSec = getTimeDomainSpanSec(state)
    const safeSec = clampSpectrogramCursorSecToLiveData(seconds, state) - state.timeDomainMinSec
    const ratio = safeSec / domainSpanSec
    return clamp(Math.round(ratio * (capacity - 1)), 0, capacity - 1)
  }

  const withHistoryColumn = (timelineIndex: number, cb: (column: Float32Array) => void): void => {
    if (frequencyHistoryRing.capacity <= 0 || frequencyHistoryRing.bins <= 0 || frequencyHistoryRing.data.length <= 0) {
      return
    }
    const clampedIndex = clamp(timelineIndex, 0, frequencyHistoryRing.capacity - 1)
    const ringIndex = (frequencyHistoryRing.head + clampedIndex) % frequencyHistoryRing.capacity
    const offset = ringIndex * frequencyHistoryRing.bins
    cb(frequencyHistoryRing.data.subarray(offset, offset + frequencyHistoryRing.bins))
  }

  const averageHistoryRange = (startIndex: number, endExclusive: number): Float32Array => {
    const bins = frequencyHistoryRing.bins
    if (bins <= 0 || frequencyHistoryRing.capacity <= 0) {
      return new Float32Array(0)
    }

    if (fftProfileAccumulator.length !== bins) {
      fftProfileAccumulator = new Float32Array(bins)
    } else {
      fftProfileAccumulator.fill(0)
    }

    const safeStart = clamp(startIndex, 0, frequencyHistoryRing.capacity - 1)
    const safeEnd = clamp(endExclusive, safeStart + 1, frequencyHistoryRing.capacity)
    const sampleCount = Math.max(1, safeEnd - safeStart)

    for (let index = safeStart; index < safeEnd; index += 1) {
      withHistoryColumn(index, (column) => {
        for (let bin = 0; bin < bins; bin += 1) {
          const current = fftProfileAccumulator[bin] ?? 0
          fftProfileAccumulator[bin] = current + (column[bin] ?? SILENCE_DECIBELS)
        }
      })
    }

    const averaged = new Float32Array(bins)
    for (let bin = 0; bin < bins; bin += 1) {
      averaged[bin] = (fftProfileAccumulator[bin] ?? 0) / sampleCount
    }
    return averaged
  }

  const computeFftProfile = (state: AppState, allowFallbackNotice: boolean): FftProfileState | null => {
    if (frequencyHistoryRing.capacity <= 0 || frequencyHistoryRing.bins <= 0 || frequencyHistoryRing.data.length <= 0) {
      return null
    }

    if (fftCursorState.mode === 'single') {
      const timelineIndex = resolveTimelineIndexForAbsoluteSec(state, fftCursorState.singleSec)
      let spectrum = new Float32Array(frequencyHistoryRing.bins)
      withHistoryColumn(timelineIndex, (column) => {
        spectrum = new Float32Array(column)
      })
      fftCursorState.lastFallbackNoticeKey = null
      return {
        spectrumDb: spectrum,
        source: 'frame',
        updatedAtMs: performance.now(),
      }
    }

    const minSec = Math.min(fftCursorState.rangeMinSec, fftCursorState.rangeMaxSec)
    const maxSec = Math.max(fftCursorState.rangeMinSec, fftCursorState.rangeMaxSec)
    const widthSec = Math.max(0, maxSec - minSec)
    const minimumRangeSec = getMinimumCursorRangeSec(state)
    const impossibleRange = minimumRangeSec > getTimeDomainSpanSec(state)
    const useFallback = impossibleRange || widthSec < minimumRangeSec

    if (useFallback) {
      showFallbackNoticeIfNeeded(minimumRangeSec, impossibleRange ? 'impossible' : 'short-range', allowFallbackNotice)
    } else {
      fftCursorState.lastFallbackNoticeKey = null
    }

    if (widthSec <= 0) {
      const centerSec = clampSpectrogramCursorSecToLiveData((minSec + maxSec) / 2, state)
      const timelineIndex = resolveTimelineIndexForAbsoluteSec(state, centerSec)
      let spectrum = new Float32Array(frequencyHistoryRing.bins)
      withHistoryColumn(timelineIndex, (column) => {
        spectrum = new Float32Array(column)
      })
      return {
        spectrumDb: spectrum,
        source: 'slice-fallback',
        updatedAtMs: performance.now(),
      }
    }

    const { startSlot, endSlotExclusive } = resolveTimeRangeSlots(
      minSec,
      maxSec,
      getTimeDomainSpanSec(state),
      frequencyHistoryRing.capacity,
    )

    return {
      spectrumDb: averageHistoryRange(startSlot, endSlotExclusive),
      source: useFallback ? 'slice-fallback' : 'average-frame',
      updatedAtMs: performance.now(),
    }
  }

  const resizeFftCanvas = (): PlotMetrics => {
    const dprCap = isMobileViewport() ? 1.5 : 2
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap))
    const width = Math.max(1, Math.floor(elements.fftCanvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(elements.fftCanvas.clientHeight * dpr))

    if (elements.fftCanvas.width !== width || elements.fftCanvas.height !== height) {
      elements.fftCanvas.width = width
      elements.fftCanvas.height = height
    }

    const marginLeft = 52
    const marginRight = 12
    const marginTop = 10
    const marginBottom = 30
    return {
      plotX: marginLeft,
      plotY: marginTop,
      plotWidth: Math.max(1, width - marginLeft - marginRight),
      plotHeight: Math.max(1, height - marginTop - marginBottom),
      canvasWidth: width,
      canvasHeight: height,
      dpr,
    }
  }

  const getFftFrequencyBounds = (state: AppState): FftFrequencyBounds => {
    const nyquistHz = Math.max(1, timelineSyncState.sampleRateHz / 2)
    const minHz = clamp(state.frequencyMinHz, FFT_PANEL_DOMAIN_MIN_HZ, nyquistHz)
    const maxHz = clamp(state.frequencyMaxHz, minHz + MIN_RANGE_GAP_HZ, nyquistHz)
    return {
      nyquistHz,
      minHz,
      maxHz,
      spanHz: Math.max(MIN_RANGE_GAP_HZ, maxHz - minHz),
    }
  }

  const clampFftPlotCursorHz = (state: AppState): void => {
    if (fftPlotCursorHz === null) {
      return
    }
    const bounds = getFftFrequencyBounds(state)
    fftPlotCursorHz = clamp(fftPlotCursorHz, bounds.minHz, bounds.maxHz)
  }

  const renderFftPanel = (state: AppState): void => {
    const metrics = resizeFftCanvas()
    const { plotX, plotY, plotWidth, plotHeight, canvasWidth, canvasHeight } = metrics
    const minDb = state.decibelMin
    const maxDb = state.decibelMax
    const { nyquistHz, minHz: freqMinHz, maxHz: freqMaxHz, spanHz: freqSpan } = getFftFrequencyBounds(state)
    const dbSpan = Math.max(MIN_DECIBEL_GAP, maxDb - minDb)

    fftCanvasCtx.fillStyle = 'rgb(2 8 18)'
    fftCanvasCtx.fillRect(0, 0, canvasWidth, canvasHeight)

    fftCanvasCtx.strokeStyle = 'rgba(156, 189, 236, 0.86)'
    fftCanvasCtx.lineWidth = 1
    fftCanvasCtx.strokeRect(plotX + 0.5, plotY + 0.5, plotWidth - 1, plotHeight - 1)

    fftCanvasCtx.strokeStyle = 'rgba(120, 156, 203, 0.26)'
    fftCanvasCtx.lineWidth = 1
    for (let index = 0; index < FFT_PANEL_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(FFT_PANEL_TICK_COUNT - 1, 1)
      const y = Math.round(plotY + ratio * plotHeight) + 0.5
      fftCanvasCtx.beginPath()
      fftCanvasCtx.moveTo(plotX + 0.5, y)
      fftCanvasCtx.lineTo(plotX + plotWidth + 0.5, y)
      fftCanvasCtx.stroke()
    }

    fftCanvasCtx.fillStyle = 'rgb(166 189 220)'
    fftCanvasCtx.font = '11px "Avenir Next", "Yu Gothic", sans-serif'
    fftCanvasCtx.textBaseline = 'middle'
    fftCanvasCtx.textAlign = 'right'
    for (let index = 0; index < FFT_PANEL_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(FFT_PANEL_TICK_COUNT - 1, 1)
      const valueDb = maxDb - ratio * dbSpan
      const y = Math.round(plotY + ratio * plotHeight)
      fftCanvasCtx.fillText(String(Math.round(valueDb)), plotX - 6, y)
    }

    fftCanvasCtx.textBaseline = 'top'
    for (let index = 0; index < FFT_PANEL_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(FFT_PANEL_TICK_COUNT - 1, 1)
      const valueHz = Math.round(freqMinHz + ratio * freqSpan)
      const x = Math.round(plotX + ratio * plotWidth)
      if (index === 0) {
        fftCanvasCtx.textAlign = 'left'
      } else if (index === FFT_PANEL_TICK_COUNT - 1) {
        fftCanvasCtx.textAlign = 'right'
      } else {
        fftCanvasCtx.textAlign = 'center'
      }
      fftCanvasCtx.fillText(fftNumberFormatter.format(valueHz), x, plotY + plotHeight + 6)
    }

    fftCanvasCtx.textAlign = 'right'
    fftCanvasCtx.textBaseline = 'alphabetic'
    fftCanvasCtx.fillText('Frequency [Hz]', plotX + plotWidth, canvasHeight - 4)
    fftCanvasCtx.save()
    fftCanvasCtx.translate(14, plotY + plotHeight / 2)
    fftCanvasCtx.rotate(-Math.PI / 2)
    fftCanvasCtx.textAlign = 'center'
    fftCanvasCtx.fillText('Level [dB]', 0, 0)
    fftCanvasCtx.restore()

    if (!fftProfileState || fftProfileState.spectrumDb.length <= 0) {
      fftCanvasCtx.textAlign = 'center'
      fftCanvasCtx.textBaseline = 'middle'
      fftCanvasCtx.fillText('No FFT data', plotX + plotWidth / 2, plotY + plotHeight / 2)
      return
    }

    const spectrum = fftProfileState.spectrumDb

    const sampleSpectrumDb = (frequencyHz: number): number => {
      if (spectrum.length <= 1) {
        return spectrum[0] ?? minDb
      }

      const normalizedBin = clamp((frequencyHz / nyquistHz) * (spectrum.length - 1), 0, spectrum.length - 1)
      const lowerBin = Math.floor(normalizedBin)
      const upperBin = Math.min(spectrum.length - 1, lowerBin + 1)
      const blend = normalizedBin - lowerBin
      const lowerDb = spectrum[lowerBin] ?? minDb
      const upperDb = spectrum[upperBin] ?? lowerDb
      return lowerDb + (upperDb - lowerDb) * blend
    }

    const plotYSeries = new Float32Array(plotWidth)
    let peakDb = sampleSpectrumDb(freqMinHz)
    let peakHz = freqMinHz
    let peakX = 0
    for (let x = 0; x < plotWidth; x += 1) {
      const ratio = x / Math.max(plotWidth - 1, 1)
      const freqHz = freqMinHz + ratio * freqSpan
      const rawDb = sampleSpectrumDb(freqHz)
      const yRatio = clamp((maxDb - rawDb) / dbSpan, 0, 1)
      plotYSeries[x] = plotY + yRatio * plotHeight
      if (x === 0 || rawDb > peakDb) {
        peakDb = rawDb
        peakHz = freqHz
        peakX = x
      }
    }

    if (state.isRecording) {
      fftPlotCursorHz = peakHz
    } else if (fftPlotCursorHz === null) {
      fftPlotCursorHz = freqMaxHz
    }
    clampFftPlotCursorHz(state)

    const cursorHz = clamp(fftPlotCursorHz ?? freqMaxHz, freqMinHz, freqMaxHz)
    const cursorRatio = clamp((cursorHz - freqMinHz) / freqSpan, 0, 1)
    const cursorX = plotX + cursorRatio * plotWidth
    const cursorDb = sampleSpectrumDb(cursorHz)

    fftCanvasCtx.strokeStyle = 'rgb(108 214 255)'
    fftCanvasCtx.lineWidth = 1.4
    fftCanvasCtx.lineJoin = 'round'
    fftCanvasCtx.lineCap = 'round'
    fftCanvasCtx.save()
    fftCanvasCtx.beginPath()
    fftCanvasCtx.rect(plotX, plotY, plotWidth, plotHeight)
    fftCanvasCtx.clip()
    traceCatmullRomThroughPoints(fftCanvasCtx, plotX, 1, plotYSeries)
    fftCanvasCtx.stroke()
    fftCanvasCtx.restore()

    const labelHz = state.isRecording ? peakHz : cursorHz
    const labelDb = state.isRecording ? peakDb : cursorDb
    const labelPrefix = state.isRecording ? 'Peak' : 'Cursor'
    const labelText = `${labelPrefix}: ${fftNumberFormatter.format(Math.round(labelHz))} Hz, ${labelDb.toFixed(1)} dB`

    const displayCursorX = state.isRecording ? plotX + peakX : cursorX
    const displayCursorDb = state.isRecording ? peakDb : cursorDb
    const displayCursorYRatio = clamp((maxDb - displayCursorDb) / dbSpan, 0, 1)
    const displayCursorY = plotY + displayCursorYRatio * plotHeight
    fftCanvasCtx.strokeStyle = 'rgba(255, 199, 82, 0.95)'
    fftCanvasCtx.lineWidth = 1.2
    fftCanvasCtx.beginPath()
    fftCanvasCtx.moveTo(displayCursorX + 0.5, plotY + 0.5)
    fftCanvasCtx.lineTo(displayCursorX + 0.5, plotY + plotHeight + 0.5)
    fftCanvasCtx.stroke()

    fftCanvasCtx.fillStyle = 'rgba(255, 199, 82, 0.95)'
    fftCanvasCtx.beginPath()
    fftCanvasCtx.arc(displayCursorX, displayCursorY, 2.6, 0, Math.PI * 2)
    fftCanvasCtx.fill()

    fftCanvasCtx.font = '11px "Avenir Next", "Yu Gothic", sans-serif'
    fftCanvasCtx.textAlign = 'right'
    fftCanvasCtx.textBaseline = 'top'
    const textWidth = fftCanvasCtx.measureText(labelText).width
    const labelPaddingX = 6
    const labelPaddingY = 4
    const labelHeight = 16
    const labelRight = plotX + plotWidth - 6
    const labelTop = plotY + 6
    fftCanvasCtx.fillStyle = 'rgba(6, 17, 31, 0.78)'
    fftCanvasCtx.fillRect(
      labelRight - textWidth - labelPaddingX * 2,
      labelTop - 1,
      textWidth + labelPaddingX * 2,
      labelHeight,
    )
    fftCanvasCtx.fillStyle = 'rgb(244 248 255)'
    fftCanvasCtx.fillText(labelText, labelRight - labelPaddingX, labelTop + labelPaddingY - 1)
  }

  const updateCursorOverlay = (state: AppState): void => {
    const overlayConfig: CursorOverlayConfig = {
      mode: fftCursorState.mode,
      singleSec: fftCursorState.singleSec,
      rangeMinSec: fftCursorState.rangeMinSec,
      rangeMaxSec: fftCursorState.rangeMaxSec,
    }
    renderer.setCursorOverlay(overlayConfig)

    if (fftCursorState.mode === 'single') {
      elements.fftStatusLabel.textContent = `single @ ${fftCursorState.singleSec.toFixed(3)} s`
      return
    }

    const minSec = Math.min(fftCursorState.rangeMinSec, fftCursorState.rangeMaxSec)
    const maxSec = Math.max(fftCursorState.rangeMinSec, fftCursorState.rangeMaxSec)
    if (!fftProfileState) {
      elements.fftStatusLabel.textContent = `average ${minSec.toFixed(3)}-${maxSec.toFixed(3)} s`
      return
    }

    const suffix = fftProfileState.source === 'slice-fallback' ? ' (slice fallback)' : ''
    elements.fftStatusLabel.textContent = `average ${minSec.toFixed(3)}-${maxSec.toFixed(3)} s${suffix}`
  }

  const refreshFftProfile = (allowFallbackNotice: boolean): void => {
    const state = stateStore.getState()
    fftProfileState = computeFftProfile(state, allowFallbackNotice)
    fftLastRefreshAtMs = performance.now()
    elements.fftAverageToggleButton.classList.toggle('is-active', fftCursorState.mode === 'average')
    updateCursorOverlay(state)
    renderFftPanel(state)
  }

  const scheduleFftProfileRefresh = (force: boolean, allowFallbackNotice: boolean): void => {
    fftPendingAllowFallbackNotice = fftPendingAllowFallbackNotice || allowFallbackNotice
    if (force) {
      if (fftRefreshTimeoutId !== null) {
        window.clearTimeout(fftRefreshTimeoutId)
        fftRefreshTimeoutId = null
      }
      const allowNotice = fftPendingAllowFallbackNotice
      fftPendingAllowFallbackNotice = false
      refreshFftProfile(allowNotice)
      return
    }

    const elapsed = performance.now() - fftLastRefreshAtMs
    const waitMs = Math.max(0, FFT_PROFILE_REFRESH_INTERVAL_MS - elapsed)
    if (fftRefreshTimeoutId !== null) {
      return
    }

    fftRefreshTimeoutId = window.setTimeout(() => {
      fftRefreshTimeoutId = null
      const allowNotice = fftPendingAllowFallbackNotice
      fftPendingAllowFallbackNotice = false
      refreshFftProfile(allowNotice)
    }, waitMs)
  }
  elements.recordActionIcon.replaceChildren(
    createLucideElement(Circle, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.recordStopActionIcon.replaceChildren(
    createLucideElement(Square, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.clearActionIcon.replaceChildren(
    createLucideElement(Eraser, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.loadAudioActionIcon.replaceChildren(
    createLucideElement(Upload, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.saveActionIcon.replaceChildren(
    createLucideElement(Download, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.playbackIconPlay.replaceChildren(
    createLucideElement(Play, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )
  elements.playbackIconStop.replaceChildren(
    createLucideElement(Square, {
      width: 16,
      height: 16,
      'stroke-width': 2.3,
      'aria-hidden': 'true',
      focusable: 'false',
    }),
  )

  const getHistoryCapacity = (): number => {
    const directWidth = renderer.getPlotMetrics().plotWidth
    const fallbackWidth = Math.max(1, Math.floor(elements.canvas.clientWidth))
    if (directWidth <= 1) {
      return fallbackWidth
    }
    return Math.max(directWidth, fallbackWidth)
  }

  const syncTimelineState = (): void => {
    const state = stateStore.getState()
    const sampleRateHz = Math.max(1, state.currentSampleRateHz ?? analysisService.getSampleRateHz())
    const domainSec = state.analysisSource === 'file' ? getTimeDomainSpanSec(state) : SPECTROGRAM_WINDOW_SECONDS
    const plotWidth = Math.max(1, getHistoryCapacity())
    timelineSyncState = {
      sampleRateHz,
      windowSamples: Math.max(1, Math.round(sampleRateHz * domainSec)),
      plotWidth,
      capturedSamples: state.analysisSource === 'file' ? Math.max(1, Math.round(sampleRateHz * domainSec)) : latestCapturedSamples48k,
    }
  }

  const initializeHistoryWithSilence = (
    capacity: number,
    bins: number,
    silenceDb: number,
  ): FrequencyHistoryRing => {
    const data = new Float32Array(capacity * bins)
    data.fill(silenceDb)
    return {
      data,
      capacity,
      bins,
      count: capacity,
      head: 0,
    }
  }

  const ensureHistoryRingLayout = (capacity: number, bins: number): void => {
    if (
      frequencyHistoryRing.capacity === capacity &&
      frequencyHistoryRing.bins === bins &&
      frequencyHistoryRing.data.length === capacity * bins
    ) {
      return
    }

    const previousRing = frequencyHistoryRing
    const nextRing = initializeHistoryWithSilence(capacity, bins, SILENCE_DECIBELS)

    if (previousRing.count > 0 && previousRing.bins === bins && previousRing.capacity > 0) {
      const sourceCount = Math.min(previousRing.count, previousRing.capacity)
      const targetDenominator = Math.max(capacity - 1, 1)
      const sourceDenominator = Math.max(sourceCount - 1, 1)

      for (let targetIndex = 0; targetIndex < capacity; targetIndex += 1) {
        const sourceChronologicalIndex =
          sourceCount <= 1 ? 0 : Math.floor((targetIndex / targetDenominator) * sourceDenominator)
        const sourceColumnIndex =
          (previousRing.head - sourceCount + sourceChronologicalIndex + previousRing.capacity) % previousRing.capacity
        const sourceOffset = sourceColumnIndex * bins
        const targetOffset = targetIndex * bins
        nextRing.data.set(previousRing.data.subarray(sourceOffset, sourceOffset + bins), targetOffset)
      }
    }

    frequencyHistoryRing = nextRing
    historyLinearBuffer = new Float32Array(0)
  }

  const ensureHistoryRingMatchesRenderer = (): void => {
    const state = stateStore.getState()
    const previousCapacity = frequencyHistoryRing.capacity
    const nextCapacity = getHistoryCapacity()
    const capacityChanged = previousCapacity > 0 && previousCapacity !== nextCapacity
    if (frequencyHistoryRing.bins > 0) {
      ensureHistoryRingLayout(nextCapacity, frequencyHistoryRing.bins)
    }
    syncTimelineState()
    if (state.analysisSource === 'file') {
      if (capacityChanged) {
        requestFileWindowRender(true)
      }
      return
    }

    analysisService.setPlotWidth(nextCapacity)

    if (capacityChanged && state.isRecording) {
      pendingColumnQueue = []
      void syncHistoryFromWorker()
    }
  }

  const appendHistoryColumn = (rawFrequencyData: Float32Array): void => {
    if (rawFrequencyData.length === 0) {
      return
    }

    const capacity = getHistoryCapacity()
    ensureHistoryRingLayout(capacity, rawFrequencyData.length)

    const offset = frequencyHistoryRing.head * frequencyHistoryRing.bins
    frequencyHistoryRing.data.set(rawFrequencyData, offset)
    frequencyHistoryRing.head = (frequencyHistoryRing.head + 1) % frequencyHistoryRing.capacity
    frequencyHistoryRing.count = Math.min(frequencyHistoryRing.count + 1, frequencyHistoryRing.capacity)
  }

  const ensureLinearHistoryBuffer = (columns: number, bins: number): void => {
    const required = columns * bins
    if (required <= 0) {
      historyLinearBuffer = new Float32Array(0)
      return
    }

    if (historyLinearBuffer.length !== required) {
      historyLinearBuffer = new Float32Array(required)
    }
  }

  const resolveTimeRangeSlots = (
    timeMinSec: number,
    timeMaxSec: number,
    domainSec: number,
    slotCount: number,
  ): { startSlot: number; endSlotExclusive: number } => {
    const safeDomainSec = Math.max(MIN_TIME_GAP_SEC, domainSec)
    const safeSlotCount = Math.max(1, slotCount)
    const safeMinSec = clamp(timeMinSec, 0, safeDomainSec - MIN_TIME_GAP_SEC)
    const safeMaxSec = clamp(timeMaxSec, safeMinSec + MIN_TIME_GAP_SEC, safeDomainSec)
    const startRatio = safeMinSec / safeDomainSec
    const endRatio = safeMaxSec / safeDomainSec
    const startSlot = clamp(
      Math.floor(startRatio * safeSlotCount),
      0,
      Math.max(safeSlotCount - 1, 0),
    )
    const endSlotExclusive = clamp(
      Math.ceil(endRatio * safeSlotCount),
      startSlot + 1,
      safeSlotCount,
    )

    return {
      startSlot,
      endSlotExclusive,
    }
  }

  const sampleHistoryByTimeWindow = (
    rangeMinHz: number,
    rangeMaxHz: number,
    timeMinSec: number,
    timeMaxSec: number,
    domainSec: number,
    timelineColumns: number,
    nyquistHz: number,
  ): { history: Float32Array; count: number; bins: number } => {
    const bins = frequencyHistoryRing.bins

    if (timelineColumns <= 0 || bins <= 0) {
      return { history: new Float32Array(0), count: 0, bins: 0 }
    }

    const { startSlot, endSlotExclusive } = resolveTimeRangeSlots(
      timeMinSec,
      timeMaxSec,
      domainSec,
      timelineColumns,
    )
    const selectedCount = Math.max(1, endSlotExclusive - startSlot)

    ensureLinearHistoryBuffer(selectedCount, bins)
    let writeOffset = 0

    for (let timelineIndex = startSlot; timelineIndex < endSlotExclusive; timelineIndex += 1) {
      const ringIndex = (frequencyHistoryRing.head + timelineIndex) % frequencyHistoryRing.capacity
      const sourceOffset = ringIndex * bins
      const rawColumn = frequencyHistoryRing.data.subarray(sourceOffset, sourceOffset + bins)
      const projectedFrequencyData = projectFrequencyRange(rawColumn, rangeMinHz, rangeMaxHz, nyquistHz)
      historyLinearBuffer.set(projectedFrequencyData, writeOffset)
      writeOffset += bins
    }

    return {
      history: historyLinearBuffer.subarray(0, writeOffset),
      count: Math.max(1, Math.floor(writeOffset / bins)),
      bins,
    }
  }

  const resetFrequencyHistory = (): void => {
    frequencyHistoryRing = {
      data: new Float32Array(0),
      capacity: 0,
      bins: 0,
      count: 0,
      head: 0,
    }
    historyLinearBuffer = new Float32Array(0)
  }

  const setHistoryFromLinear = (history: Float32Array, count: number, bins: number): void => {
    const capacity = Math.max(1, getHistoryCapacity())
    if (bins <= 0 || count <= 0 || history.length <= 0) {
      resetFrequencyHistory()
      return
    }

    ensureHistoryRingLayout(capacity, bins)
    frequencyHistoryRing.data.fill(SILENCE_DECIBELS)

    for (let columnIndex = 0; columnIndex < capacity; columnIndex += 1) {
      const sourceColumnIndex = count <= 1 ? 0 : Math.floor((columnIndex / Math.max(capacity - 1, 1)) * (count - 1))
      const sourceOffset = sourceColumnIndex * bins
      const targetOffset = columnIndex * bins
      frequencyHistoryRing.data.set(history.subarray(sourceOffset, sourceOffset + bins), targetOffset)
    }

    frequencyHistoryRing.head = 0
    frequencyHistoryRing.count = capacity
    historyLinearBuffer = new Float32Array(0)
  }

  const requestHistoryRender = (): void => {
    isHistoryRenderRequested = true
    if (renderHistoryRafId !== null) {
      return
    }

    renderHistoryRafId = requestAnimationFrame(() => {
      renderHistoryRafId = null
      if (!isHistoryRenderRequested) {
        return
      }
      isHistoryRenderRequested = false
      renderHistoryFromBuffer()
    })
  }

  const syncHistoryFromWorker = async (): Promise<void> => {
    if (stateStore.getState().analysisSource !== 'live') {
      return
    }
    if (historyResyncInFlight) {
      return
    }
    historyResyncInFlight = true

    try {
      const snapshot = await analysisService.requestHistorySnapshot()
      latestPcmWindow48k = snapshot.pcmWindow48k
      latestCapturedSamples48k = snapshot.capturedSamples48k
      stateStore.setState({ currentSampleRateHz: snapshot.sampleRateHz })
      timelineSyncState.capturedSamples = snapshot.capturedSamples48k
      timelineSyncState.sampleRateHz = snapshot.sampleRateHz
      timelineSyncState.windowSamples = Math.max(1, Math.round(snapshot.sampleRateHz * SPECTROGRAM_WINDOW_SECONDS))
      setHistoryFromLinear(snapshot.spectrogramHistory, snapshot.count, snapshot.bins)
      clampFftCursorsToActiveDomain()
      requestHistoryRender()
      scheduleFftProfileRefresh(true, false)
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, '解析履歴の同期に失敗しました。'),
      })
    } finally {
      historyResyncInFlight = false
    }
  }

  const clearFileRenderThrottle = (): void => {
    if (fileRenderThrottleTimer !== null) {
      window.clearTimeout(fileRenderThrottleTimer)
      fileRenderThrottleTimer = null
    }
  }

  const requestFileWindowRender = (immediate: boolean): void => {
    const state = stateStore.getState()
    if (state.analysisSource !== 'file') {
      return
    }

    const run = async (): Promise<void> => {
      clearFileRenderThrottle()
      if (fileRenderInFlight) {
        pendingFileRenderAfterCurrent = true
        return
      }

      const renderState = stateStore.getState()
      if (renderState.analysisSource !== 'file') {
        return
      }

      fileRenderInFlight = true
      pendingFileRenderAfterCurrent = false
      fileRenderSequence += 1
      const currentSequence = fileRenderSequence
      stateStore.setState({ isLoadingFile: true })

      try {
        const result = await fileAnalysisService.renderWindow({
          timeMinSec: renderState.timeMinSec,
          timeMaxSec: renderState.timeMaxSec,
          plotWidth: Math.max(1, getHistoryCapacity()),
          frameSize: renderState.analysisFrameSize,
          overlapPercent: renderState.analysisOverlapPercent,
        })

        const latestState = stateStore.getState()
        if (currentSequence !== fileRenderSequence || latestState.analysisSource !== 'file') {
          return
        }

        setHistoryFromLinear(result.history, result.count, result.bins)
        syncTimelineState()
        requestHistoryRender()
        scheduleFftProfileRefresh(true, false)
        if (latestState.isLoadingFile) {
          stateStore.setState({ isLoadingFile: false })
        }
      } catch (error) {
        if (currentSequence !== fileRenderSequence) {
          return
        }
        stateStore.setState({
          isLoadingFile: false,
          errorMessage: toErrorMessage(error, '音声ファイル解析に失敗しました。'),
        })
      } finally {
        if (currentSequence === fileRenderSequence) {
          fileRenderInFlight = false
        }
        if (pendingFileRenderAfterCurrent && stateStore.getState().analysisSource === 'file') {
          pendingFileRenderAfterCurrent = false
          requestFileWindowRender(false)
        }
      }
    }

    if (immediate) {
      void run()
      return
    }

    if (fileRenderThrottleTimer !== null) {
      return
    }
    fileRenderThrottleTimer = window.setTimeout(() => {
      void run()
    }, FILE_RENDER_THROTTLE_MS)
  }

  const resetAnalysisBuffers = (): void => {
    renderGateAccumulatorSeconds = 0
    frameTimeEmaMs = 1000 / DESKTOP_QUALITY_PROFILE.renderFps
    aboveLevel1FrameCount = 0
    aboveLevel2FrameCount = 0
    belowRecoveryFrameCount = 0
    pendingColumnQueue = []
    syncTimelineState()
  }

  const mergeAnalysisFrame = (column: Float32Array): void => {
    if (column.length === 0) {
      return
    }

    if (pendingColumnQueue.length >= MAX_PENDING_ANALYSIS_COLUMNS) {
      pendingColumnQueue.splice(0, Math.floor(MAX_PENDING_ANALYSIS_COLUMNS / 2))
      if (!historyResyncInFlight) {
        void syncHistoryFromWorker()
      }
    }

    const queuedColumn = new Float32Array(column.length)
    queuedColumn.set(column)
    pendingColumnQueue.push(queuedColumn)
  }

  const consumeColumnData = (): Float32Array | null => {
    const queuedColumn = pendingColumnQueue.shift()
    if (queuedColumn) {
      return queuedColumn
    }
    return null
  }

  const getActiveQualityProfile = (): QualityProfile => {
    if (!isMobileViewport()) {
      return DESKTOP_QUALITY_PROFILE
    }
    const fallbackProfile = MOBILE_QUALITY_PROFILES[0]!
    return MOBILE_QUALITY_PROFILES[activeQualityStageIndex] ?? fallbackProfile
  }

  const syncFrequencySliderToPlot = (): void => {
    const metrics = renderer.getPlotMetrics()
    const dpr = Math.max(1, metrics.dpr)
    const sliderTopPx = Math.max(0, metrics.plotY / dpr)
    const sliderHeightPx = Math.max(1, metrics.plotHeight / dpr)
    const canvasHeightPx = Math.max(sliderTopPx + sliderHeightPx, metrics.canvasHeight / dpr)

    const sliderColumn = document.getElementById('freq-slider-column')
    if (sliderColumn instanceof HTMLElement) {
      sliderColumn.style.height = `${canvasHeightPx}px`
    }

    elements.freqSlider.style.setProperty('--slider-offset', `${sliderTopPx}px`)
    elements.freqSlider.style.setProperty('--slider-height', `${sliderHeightPx}px`)
  }

  const applyRendererLayout = (): void => {
    renderer.resizeForContainer()
    syncFrequencySliderToPlot()
    ensureHistoryRingMatchesRenderer()
  }

  const updateAxisConfig = (state: AppState): void => {
    const timeSpanSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    axisConfig.frequencyMinHz = state.frequencyMinHz
    axisConfig.frequencyMaxHz = state.frequencyMaxHz
    axisConfig.timeWindowSec = timeSpanSec
    axisConfig.timeLabelOffsetSec = state.timeMinSec
    axisConfig.xTicksSec = buildTimeTicks(state.timeMinSec, state.timeMaxSec)
    renderer.composeAxes(axisConfig)
  }

  const renderAnalysisControls = (state: AppState): void => {
    elements.frameSizeSelect.value = String(state.analysisFrameSize)
    elements.upperFrequencySelect.value = String(state.analysisUpperFrequencyHz)
    elements.overlapInput.min = String(MIN_OVERLAP_PERCENT)
    elements.overlapInput.max = String(MAX_OVERLAP_PERCENT)
    elements.overlapInput.step = '1'

    if (document.activeElement !== elements.overlapInput) {
      elements.overlapInput.value = String(state.analysisOverlapPercent)
    }
  }

  const renderDecibelTicks = (minDb: number, maxDb: number): void => {
    const fragment = document.createDocumentFragment()
    const spanDb = Math.max(MIN_DECIBEL_GAP, maxDb - minDb)

    for (let index = 0; index < DECIBEL_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(DECIBEL_TICK_COUNT - 1, 1)
      const valueDb = maxDb - ratio * spanDb
      const roundedDb = Math.round(valueDb)

      const tick = document.createElement('div')
      tick.className = 'db-tick'

      const label = document.createElement('span')
      label.className = 'db-tick-label'
      label.textContent = `${roundedDb}`

      tick.append(label)
      fragment.append(tick)
    }

    elements.dbTicks.replaceChildren(fragment)
  }

  const renderDecibelControls = (state: AppState): void => {
    const isLocked = state.isLoadingFile || (conservativeMode && state.isRecording)
    elements.dbMinInput.disabled = isLocked
    elements.dbMaxInput.disabled = isLocked
    elements.dbHandleMin.disabled = isLocked
    elements.dbHandleMax.disabled = isLocked

    elements.dbMinInput.min = String(DECIBEL_INPUT_MIN)
    elements.dbMinInput.max = String(state.decibelMax - MIN_DECIBEL_GAP)
    elements.dbMinInput.step = String(DECIBEL_STEP)
    elements.dbMaxInput.min = String(state.decibelMin + MIN_DECIBEL_GAP)
    elements.dbMaxInput.max = String(DECIBEL_INPUT_MAX)
    elements.dbMaxInput.step = String(DECIBEL_STEP)

    if (document.activeElement !== elements.dbMinInput) {
      elements.dbMinInput.value = String(state.decibelMin)
    }

    if (document.activeElement !== elements.dbMaxInput) {
      elements.dbMaxInput.value = String(state.decibelMax)
    }

    const maxRatio = toDecibelSliderRatio(state.decibelMax, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX)
    const minRatio = toDecibelSliderRatio(state.decibelMin, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX)

    elements.dbHandleMax.style.top = `${maxRatio * 100}%`
    elements.dbHandleMin.style.top = `${minRatio * 100}%`

    const selectionTopRatio = Math.min(maxRatio, minRatio)
    const selectionHeightRatio = Math.max(0, Math.abs(minRatio - maxRatio))
    elements.dbSliderSelection.style.top = `${selectionTopRatio * 100}%`
    elements.dbSliderSelection.style.height = `${selectionHeightRatio * 100}%`
  }

  const renderFrequencyControls = (state: AppState): void => {
    const isLocked = state.isLoadingFile || (conservativeMode && state.isRecording)
    elements.freqMinInput.disabled = isLocked
    elements.freqMaxInput.disabled = isLocked
    elements.freqHandleMin.disabled = isLocked
    elements.freqHandleMax.disabled = isLocked

    elements.freqMinInput.step = String(FREQUENCY_STEP_HZ)
    elements.freqMaxInput.step = String(FREQUENCY_STEP_HZ)

    elements.freqMinInput.min = String(state.frequencyDomainMinHz)
    elements.freqMinInput.max = String(state.frequencyMaxHz - MIN_RANGE_GAP_HZ)
    elements.freqMaxInput.min = String(state.frequencyMinHz + MIN_RANGE_GAP_HZ)
    elements.freqMaxInput.max = String(state.frequencyDomainMaxHz)

    if (document.activeElement !== elements.freqMinInput) {
      elements.freqMinInput.value = String(state.frequencyMinHz)
    }

    if (document.activeElement !== elements.freqMaxInput) {
      elements.freqMaxInput.value = String(state.frequencyMaxHz)
    }

    const maxRatio = toSliderRatio(
      state.frequencyMaxHz,
      state.frequencyDomainMinHz,
      state.frequencyDomainMaxHz,
    )
    const minRatio = toSliderRatio(
      state.frequencyMinHz,
      state.frequencyDomainMinHz,
      state.frequencyDomainMaxHz,
    )

    elements.freqHandleMax.style.top = `${maxRatio * 100}%`
    elements.freqHandleMin.style.top = `${minRatio * 100}%`

    const selectionTopRatio = Math.min(maxRatio, minRatio)
    const selectionHeightRatio = Math.max(0, Math.abs(minRatio - maxRatio))
    elements.freqSliderSelection.style.top = `${selectionTopRatio * 100}%`
    elements.freqSliderSelection.style.height = `${selectionHeightRatio * 100}%`
  }

  const renderTimeControls = (state: AppState): void => {
    const lockTimeRange = state.isPlayingBack || state.isRecording || state.isLoadingFile || conservativeMode
    elements.timeMinInput.disabled = lockTimeRange
    elements.timeMaxInput.disabled = lockTimeRange
    elements.timeHandleMin.disabled = lockTimeRange
    elements.timeHandleMax.disabled = lockTimeRange

    elements.timeMinInput.min = String(state.timeDomainMinSec)
    elements.timeMinInput.max = String(state.timeMaxSec - MIN_TIME_GAP_SEC)
    elements.timeMinInput.step = String(TIME_STEP_SEC)
    elements.timeMaxInput.min = String(state.timeMinSec + MIN_TIME_GAP_SEC)
    elements.timeMaxInput.max = String(state.timeDomainMaxSec)
    elements.timeMaxInput.step = String(TIME_STEP_SEC)

    if (document.activeElement !== elements.timeMinInput) {
      elements.timeMinInput.value = state.timeMinSec.toFixed(1)
    }

    if (document.activeElement !== elements.timeMaxInput) {
      elements.timeMaxInput.value = state.timeMaxSec.toFixed(1)
    }

    const minRatio = toTimeSliderRatio(state.timeMinSec, state.timeDomainMinSec, state.timeDomainMaxSec)
    const maxRatio = toTimeSliderRatio(state.timeMaxSec, state.timeDomainMinSec, state.timeDomainMaxSec)

    elements.timeHandleMin.style.left = `${minRatio * 100}%`
    elements.timeHandleMax.style.left = `${maxRatio * 100}%`

    const selectionLeftRatio = Math.min(minRatio, maxRatio)
    const selectionWidthRatio = Math.max(0, Math.abs(maxRatio - minRatio))
    elements.timeSliderSelection.style.left = `${selectionLeftRatio * 100}%`
    elements.timeSliderSelection.style.width = `${selectionWidthRatio * 100}%`
  }

  const restoreFrequencyInputs = (): void => {
    const state = stateStore.getState()
    elements.freqMinInput.value = String(state.frequencyMinHz)
    elements.freqMaxInput.value = String(state.frequencyMaxHz)
  }

  const restoreTimeInputs = (): void => {
    const state = stateStore.getState()
    elements.timeMinInput.value = state.timeMinSec.toFixed(1)
    elements.timeMaxInput.value = state.timeMaxSec.toFixed(1)
  }

  const restoreOverlapInput = (): void => {
    const state = stateStore.getState()
    elements.overlapInput.value = String(state.analysisOverlapPercent)
  }

  const commitOverlapInput = (): void => {
    const state = stateStore.getState()
    const parsedPercent = parseOverlapInput(elements.overlapInput.value)
    if (parsedPercent === null) {
      showNumericInputAlert('Overlap [%]')
      restoreOverlapInput()
      return
    }
    elements.overlapInput.value = String(parsedPercent)

    if (parsedPercent < MIN_OVERLAP_PERCENT || parsedPercent > MAX_OVERLAP_PERCENT) {
      showInputRangeAlert('Overlap [%]', MIN_OVERLAP_PERCENT, MAX_OVERLAP_PERCENT, 1)
      restoreOverlapInput()
      return
    }

    if (parsedPercent === state.analysisOverlapPercent) {
      return
    }

    stateStore.setState({ analysisOverlapPercent: parsedPercent })
    const refreshedState = stateStore.getState()
    if (refreshedState.analysisSource === 'file') {
      requestFileWindowRender(true)
      return
    }
    if (!refreshedState.isRecording) {
      analysisService.start({
        frameSize: refreshedState.analysisFrameSize,
        overlapPercent: refreshedState.analysisOverlapPercent,
        plotWidth: Math.max(1, getHistoryCapacity()),
      })
      void syncHistoryFromWorker()
    }
  }

  const restoreDecibelInputs = (): void => {
    const state = stateStore.getState()
    elements.dbMinInput.value = String(state.decibelMin)
    elements.dbMaxInput.value = String(state.decibelMax)
  }

  const setDecibelRange = (minDb: number, maxDb: number): void => {
    const state = stateStore.getState()
    const normalized = normalizeDecibelRange(minDb, maxDb)
    if (normalized.minDb === state.decibelMin && normalized.maxDb === state.decibelMax) {
      return
    }

    stateStore.setState({
      decibelMin: normalized.minDb,
      decibelMax: normalized.maxDb,
    })
  }

  const setTimeRange = (minSec: number, maxSec: number): void => {
    const state = stateStore.getState()
    const normalized = normalizeTimeRange(minSec, maxSec, state.timeDomainMinSec, state.timeDomainMaxSec)
    if (normalized.minSec === state.timeMinSec && normalized.maxSec === state.timeMaxSec) {
      return
    }

    stateStore.setState({
      timeMinSec: normalized.minSec,
      timeMaxSec: normalized.maxSec,
    })
  }

  const commitDecibelInput = (target: DragHandle): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile || (conservativeMode && state.isRecording)) {
      restoreDecibelInputs()
      return
    }
    const inputEl = target === 'min' ? elements.dbMinInput : elements.dbMaxInput
    const parsedDb = parseDecibelInput(inputEl.value)
    if (parsedDb === null) {
      showNumericInputAlert(target === 'min' ? 'Amp.Min' : 'Amp.Max')
      restoreDecibelInputs()
      return
    }
    inputEl.value = String(parsedDb)

    if (target === 'min') {
      const minAllowed = DECIBEL_INPUT_MIN
      const maxAllowed = state.decibelMax - MIN_DECIBEL_GAP
      const isValid = parsedDb >= minAllowed && parsedDb <= maxAllowed
      if (!isValid) {
        showInputRangeAlert('Amp.Min', minAllowed, maxAllowed, DECIBEL_STEP)
        restoreDecibelInputs()
        return
      }

      setDecibelRange(parsedDb, state.decibelMax)
      return
    }

    const minAllowed = state.decibelMin + MIN_DECIBEL_GAP
    const maxAllowed = DECIBEL_INPUT_MAX
    const isValid = parsedDb <= maxAllowed && parsedDb >= minAllowed
    if (!isValid) {
      showInputRangeAlert('Amp.Max', minAllowed, maxAllowed, DECIBEL_STEP)
      restoreDecibelInputs()
      return
    }

    setDecibelRange(state.decibelMin, parsedDb)
  }

  const setFrequencyRange = (minHz: number, maxHz: number): void => {
    const state = stateStore.getState()
    const normalized = normalizeFrequencyRange(
      minHz,
      maxHz,
      state.frequencyDomainMinHz,
      state.frequencyDomainMaxHz,
    )

    if (normalized.minHz === state.frequencyMinHz && normalized.maxHz === state.frequencyMaxHz) {
      return
    }

    stateStore.setState({
      frequencyMinHz: normalized.minHz,
      frequencyMaxHz: normalized.maxHz,
    })
  }

  const setFrequencyDomainMax = (domainMaxHzRaw: number): void => {
    const state = stateStore.getState()
    const nextDomainMaxHz = Math.max(
      state.frequencyDomainMinHz + MIN_RANGE_GAP_HZ,
      roundToFrequencyStep(domainMaxHzRaw),
    )

    const normalized = normalizeFrequencyRange(
      state.frequencyMinHz,
      state.frequencyMaxHz,
      state.frequencyDomainMinHz,
      nextDomainMaxHz,
    )

    stateStore.setState({
      frequencyDomainMaxHz: nextDomainMaxHz,
      frequencyMinHz: normalized.minHz,
      frequencyMaxHz: normalized.maxHz,
    })
  }

  const commitFrequencyInput = (target: DragHandle): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile || (conservativeMode && state.isRecording)) {
      restoreFrequencyInputs()
      return
    }
    const inputEl = target === 'min' ? elements.freqMinInput : elements.freqMaxInput
    const parsedHz = parseFrequencyInput(inputEl.value)

    if (parsedHz === null) {
      showNumericInputAlert(target === 'min' ? 'Freq.Min' : 'Freq.Max')
      restoreFrequencyInputs()
      return
    }
    inputEl.value = String(parsedHz)

    if (target === 'min') {
      const minAllowed = state.frequencyDomainMinHz
      const maxAllowed = state.frequencyMaxHz - MIN_RANGE_GAP_HZ
      const isValid = parsedHz >= minAllowed && parsedHz <= maxAllowed
      if (!isValid) {
        showInputRangeAlert('Freq.Min', minAllowed, maxAllowed, FREQUENCY_STEP_HZ)
        restoreFrequencyInputs()
        return
      }

      stateStore.setState({ frequencyMinHz: parsedHz })
      return
    }

    const minAllowed = state.frequencyMinHz + MIN_RANGE_GAP_HZ
    const maxAllowed = state.frequencyDomainMaxHz
    const isValid = parsedHz <= maxAllowed && parsedHz >= minAllowed
    if (!isValid) {
      showInputRangeAlert('Freq.Max', minAllowed, maxAllowed, FREQUENCY_STEP_HZ)
      restoreFrequencyInputs()
      return
    }

    stateStore.setState({ frequencyMaxHz: parsedHz })
  }

  const commitTimeInput = (target: DragHandle): void => {
    const state = stateStore.getState()
    if (state.isRecording || state.isPlayingBack || state.isLoadingFile || conservativeMode) {
      restoreTimeInputs()
      return
    }
    const inputEl = target === 'min' ? elements.timeMinInput : elements.timeMaxInput
    const parsedSec = parseTimeInput(inputEl.value)

    if (parsedSec === null) {
      showNumericInputAlert(target === 'min' ? 'Time.Min' : 'Time.Max')
      restoreTimeInputs()
      return
    }
    inputEl.value = formatByStep(parsedSec, TIME_STEP_SEC)

    if (target === 'min') {
      const minAllowed = state.timeDomainMinSec
      const maxAllowed = state.timeMaxSec - MIN_TIME_GAP_SEC
      const isValid = parsedSec >= minAllowed && parsedSec <= maxAllowed
      if (!isValid) {
        showInputRangeAlert('Time.Min', minAllowed, maxAllowed, TIME_STEP_SEC)
        restoreTimeInputs()
        return
      }

      setTimeRange(parsedSec, state.timeMaxSec)
      return
    }

    const minAllowed = state.timeMinSec + MIN_TIME_GAP_SEC
    const maxAllowed = state.timeDomainMaxSec
    const isValid = parsedSec <= maxAllowed && parsedSec >= minAllowed
    if (!isValid) {
      showInputRangeAlert('Time.Max', minAllowed, maxAllowed, TIME_STEP_SEC)
      restoreTimeInputs()
      return
    }

    setTimeRange(state.timeMinSec, parsedSec)
  }

  const applySliderClientY = (clientY: number, target: DragHandle): void => {
    const state = stateStore.getState()
    const rect = elements.freqSlider.getBoundingClientRect()

    if (rect.height <= 0) {
      return
    }

    const ratio = clamp((clientY - rect.top) / rect.height, 0, 1)
    const candidateHz = fromSliderRatio(
      ratio,
      state.frequencyDomainMinHz,
      state.frequencyDomainMaxHz,
    )

    if (target === 'max') {
      const nextMaxHz = clamp(
        candidateHz,
        state.frequencyMinHz + MIN_RANGE_GAP_HZ,
        state.frequencyDomainMaxHz,
      )
      setFrequencyRange(state.frequencyMinHz, nextMaxHz)
      return
    }

    const nextMinHz = clamp(
      candidateHz,
      state.frequencyDomainMinHz,
      state.frequencyMaxHz - MIN_RANGE_GAP_HZ,
    )
    setFrequencyRange(nextMinHz, state.frequencyMaxHz)
  }

  const applyDecibelSliderClientY = (clientY: number, target: DragHandle): void => {
    const state = stateStore.getState()
    const rect = elements.dbSlider.getBoundingClientRect()

    if (rect.height <= 0) {
      return
    }

    const ratio = clamp((clientY - rect.top) / rect.height, 0, 1)
    const candidateDb = fromDecibelSliderRatio(ratio, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX)

    if (target === 'max') {
      const nextMaxDb = clamp(candidateDb, state.decibelMin + MIN_DECIBEL_GAP, DECIBEL_INPUT_MAX)
      setDecibelRange(state.decibelMin, nextMaxDb)
      return
    }

    const nextMinDb = clamp(candidateDb, DECIBEL_INPUT_MIN, state.decibelMax - MIN_DECIBEL_GAP)
    setDecibelRange(nextMinDb, state.decibelMax)
  }

  const applyTimeSliderClientX = (clientX: number, target: DragHandle): void => {
    const state = stateStore.getState()
    const rect = elements.timeSlider.getBoundingClientRect()

    if (rect.width <= 0) {
      return
    }

    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
    const candidateSec = fromTimeSliderRatio(ratio, state.timeDomainMinSec, state.timeDomainMaxSec)

    if (target === 'max') {
      const nextMaxSec = clamp(candidateSec, state.timeMinSec + MIN_TIME_GAP_SEC, state.timeDomainMaxSec)
      setTimeRange(state.timeMinSec, nextMaxSec)
      return
    }

    const nextMinSec = clamp(candidateSec, state.timeDomainMinSec, state.timeMaxSec - MIN_TIME_GAP_SEC)
    setTimeRange(nextMinSec, state.timeMaxSec)
  }

  const projectFrequencyRange = (
    rawFrequencyData: Float32Array,
    rangeMinHz: number,
    rangeMaxHz: number,
    nyquistHz: number,
  ): Float32Array => {
    if (rawFrequencyData.length === 0) {
      return rawFrequencyData
    }

    const outputLength = rawFrequencyData.length
    if (projectionBuffer.length < outputLength) {
      projectionBuffer = new Float32Array(outputLength)
    }

    const maxIndex = rawFrequencyData.length - 1
    const safeNyquistHz = Math.max(1, nyquistHz)
    const spanHz = Math.max(MIN_RANGE_GAP_HZ, rangeMaxHz - rangeMinHz)

    for (let index = 0; index < outputLength; index += 1) {
      const ratio = outputLength > 1 ? index / (outputLength - 1) : 0
      // Renderer assumes bin index grows from low->high and maps high bin to top row.
      const selectedHz = rangeMinHz + ratio * spanHz
      const selectedBin = clamp(Math.round((selectedHz / safeNyquistHz) * maxIndex), 0, maxIndex)
      projectionBuffer[index] = rawFrequencyData[selectedBin] ?? 0
    }

    return projectionBuffer.subarray(0, outputLength)
  }

  const renderHistoryFromBuffer = (): void => {
    const state = stateStore.getState()
    if (frequencyHistoryRing.capacity <= 0 || frequencyHistoryRing.bins <= 0) {
      renderer.clear()
      return
    }

    const nyquistHz = Math.max(state.frequencyDomainMaxHz, timelineSyncState.sampleRateHz / 2)
    const domainSec = getTimeDomainSpanSec(state)
    const projectedHistory = sampleHistoryByTimeWindow(
      state.frequencyMinHz,
      state.frequencyMaxHz,
      state.timeMinSec,
      state.timeMaxSec,
      domainSec,
      frequencyHistoryRing.capacity,
      nyquistHz,
    )
    renderer.redrawHistory(
      projectedHistory.history,
      projectedHistory.count,
      projectedHistory.bins,
      state.decibelMin,
      state.decibelMax,
      state.colormapId,
    )
  }

  const formatPlaybackClock = (seconds: number): string => {
    const safeSeconds = Math.max(0, Math.floor(seconds))
    const minutes = Math.floor(safeSeconds / 60)
    const secondsPart = safeSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}`
  }

  const setPlaybackProgressUi = (elapsedSec: number, durationSec: number): void => {
    const safeDurationSec = Math.max(0, durationSec)
    const safeElapsedSec = clamp(elapsedSec, 0, safeDurationSec)
    const ratio = safeDurationSec > 0 ? safeElapsedSec / safeDurationSec : 0
    elements.playbackProgressFill.style.width = `${ratio * 100}%`
    elements.playbackProgressTrack.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
    elements.playbackTimeLabel.textContent = `${formatPlaybackClock(safeElapsedSec)} / ${formatPlaybackClock(safeDurationSec)}`
  }

  const stopPlaybackProgressLoop = (): void => {
    if (playbackProgressRafId !== null) {
      cancelAnimationFrame(playbackProgressRafId)
      playbackProgressRafId = null
    }
  }

  const startPlaybackProgressLoop = (): void => {
    stopPlaybackProgressLoop()
    const tick = (): void => {
      if (!stateStore.getState().isPlayingBack || !playbackContext) {
        playbackProgressRafId = null
        return
      }

      const elapsedSec = Math.max(0, playbackContext.currentTime - playbackStartTimeSec)
      setPlaybackProgressUi(elapsedSec, playbackDurationSec)
      playbackProgressRafId = requestAnimationFrame(tick)
    }

    tick()
  }

  const renderPlaybackWidget = (state: AppState, hasSavableAudio: boolean): void => {
    const canTogglePlayback = !state.isRecording && !state.isSavingAudio && !state.isLoadingFile && hasSavableAudio
    elements.playbackToggleButton.disabled = !canTogglePlayback
    elements.playbackToggleButton.classList.toggle('is-playing', state.isPlayingBack)
    elements.playbackToggleButton.setAttribute('aria-label', state.isPlayingBack ? 'Stop playback' : 'Play visible range')

    if (!state.isPlayingBack) {
      const selectedDurationSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
      setPlaybackProgressUi(0, selectedDurationSec)
    }
  }

  const formatAnalysisMetricsText = (sampleRateHz: number, frameSize: FrameSize): string => {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || !Number.isFinite(frameSize) || frameSize <= 0) {
      return 'Actual Fs: - Hz | dt: - s | Δf: - Hz'
    }

    const dtSec = 1 / sampleRateHz
    const freqResolutionHz = sampleRateHz / frameSize
    const dtText = dtSec >= 1e-3 ? dtSec.toFixed(6) : dtSec.toExponential(3)

    return `Actual Fs: ${Math.round(sampleRateHz)} Hz | dt: ${dtText} s | Δf: ${freqResolutionHz.toFixed(2)} Hz`
  }

  elements.canvas.dataset.dprCap = String(getActiveQualityProfile().dprCap)
  applyRendererLayout()
  updateAxisConfig(stateStore.getState())
  analysisColumnsUnsubscribe = analysisService.subscribeColumns((column) => {
    latestCapturedSamples48k = column.capturedSamples48k
    timelineSyncState.capturedSamples = column.capturedSamples48k
    mergeAnalysisFrame(column.spectrum)
    if (stateStore.getState().isRecording && frameId === null) {
      lastAnimationTimestamp = null
      frameId = requestAnimationFrame(drawFrame)
    }
  })
  const initialState = stateStore.getState()
  analysisService.start({
    frameSize: initialState.analysisFrameSize,
    overlapPercent: initialState.analysisOverlapPercent,
    plotWidth: Math.max(1, getHistoryCapacity()),
  })
  stateStore.setState({ currentSampleRateHz: analysisService.getSampleRateHz() })
  void syncHistoryFromWorker()
  scheduleFftProfileRefresh(true, false)

  const resolveDisplayedAudioSlice = async (state: AppState): Promise<DisplayedAudioSlice | null> => {
    if (state.analysisSource === 'file') {
      const fileSlice = await fileAnalysisService.sliceAudio(state.timeMinSec, state.timeMaxSec)
      if (!fileSlice || fileSlice.samples.length <= 0 || fileSlice.sampleRateHz <= 0) {
        return null
      }

      return {
        samples: fileSlice.samples,
        sampleRateHz: fileSlice.sampleRateHz,
        startSample: 0,
        endSample: fileSlice.samples.length,
      }
    }

    const liveDataWindow = getLiveDataWindow()
    if (!liveDataWindow.hasData || latestPcmWindow48k.length <= 0 || latestCapturedSamples48k <= 0) {
      return null
    }

    const slotCount = Math.max(1, timelineSyncState.plotWidth || frequencyHistoryRing.capacity || getHistoryCapacity())
    const domainSec = getTimeDomainSpanSec(state)
    const { startSlot, endSlotExclusive } = resolveTimeRangeSlots(
      state.timeMinSec,
      state.timeMaxSec,
      domainSec,
      slotCount,
    )
    const windowSamples = Math.max(1, latestPcmWindow48k.length)
    const startSample = clamp(
      Math.floor((startSlot / slotCount) * windowSamples),
      0,
      Math.max(windowSamples - 1, 0),
    )
    const endSample = clamp(
      Math.ceil((endSlotExclusive / slotCount) * windowSamples),
      startSample + 1,
      windowSamples,
    )
    const selectedRange = intersectSelectionWithLiveData(startSample, endSample, liveDataWindow)
    if (!selectedRange) {
      return null
    }

    const samples = latestPcmWindow48k.subarray(selectedRange.start, selectedRange.end)
    if (samples.length <= 0) {
      return null
    }

    return {
      samples,
      sampleRateHz: timelineSyncState.sampleRateHz,
      startSample: selectedRange.start,
      endSample: selectedRange.end,
    }
  }

  const hasSavableAudioData = (): boolean => {
    const state = stateStore.getState()
    if (state.analysisSource === 'file') {
      return Boolean(state.loadedAudioDurationSec && state.loadedAudioDurationSec > 0 && state.currentSampleRateHz)
    }
    return timelineSyncState.sampleRateHz > 0 && latestPcmWindow48k.length > 0 && latestCapturedSamples48k > 0
  }

  const stopPlayback = async (): Promise<void> => {
    stopPlaybackProgressLoop()
    const activeSource = playbackSourceNode
    const activeContext = playbackContext
    playbackSourceNode = null
    playbackContext = null
    playbackStartTimeSec = 0
    playbackDurationSec = 0

    if (activeSource) {
      activeSource.onended = null
      try {
        activeSource.stop()
      } catch {
        // Ignore InvalidStateError if the source already ended.
      }
      activeSource.disconnect()
    }

    if (activeContext) {
      await activeContext.close().catch(() => undefined)
    }

    if (stateStore.getState().isPlayingBack) {
      stateStore.setState({ isPlayingBack: false })
    }
  }

  const startPlayback = async (): Promise<void> => {
    const state = stateStore.getState()
    if (state.isRecording || state.isPlayingBack || state.isSavingAudio || state.isLoadingFile) {
      return
    }

    const displayedSlice = await resolveDisplayedAudioSlice(state)
    if (!displayedSlice) {
      stateStore.setState({
        errorMessage:
          state.analysisSource === 'live' && hasSavableAudioData()
            ? NO_REAL_DATA_RANGE_MESSAGE
            : '再生可能な録音データがありません。',
      })
      return
    }

    await stopPlayback()

    const context = new AudioContext()
    if (context.state === 'suspended') {
      await context.resume()
    }

    const playbackSamples = new Float32Array(displayedSlice.samples)
    const buffer = context.createBuffer(1, playbackSamples.length, displayedSlice.sampleRateHz)
    buffer.copyToChannel(playbackSamples, 0)

    const sourceNode = context.createBufferSource()
    sourceNode.buffer = buffer
    sourceNode.connect(context.destination)

    playbackContext = context
    playbackSourceNode = sourceNode
    playbackStartTimeSec = context.currentTime
    playbackDurationSec = buffer.duration
    setPlaybackProgressUi(0, playbackDurationSec)
    sourceNode.onended = () => {
      if (playbackSourceNode !== sourceNode) {
        return
      }
      void stopPlayback()
    }

    stateStore.setState({
      isPlayingBack: true,
      errorMessage: null,
    })

    sourceNode.start()
    startPlaybackProgressLoop()
  }

  const saveDisplayedAudio = async (): Promise<void> => {
    const state = stateStore.getState()
    if (state.isRecording || state.isPlayingBack || state.isSavingAudio || state.isLoadingFile) {
      return
    }

    const displayedSlice = await resolveDisplayedAudioSlice(state)
    if (!displayedSlice) {
      stateStore.setState({
        errorMessage:
          state.analysisSource === 'live' && hasSavableAudioData()
            ? NO_REAL_DATA_RANGE_MESSAGE
            : '保存可能な録音データがありません。',
      })
      return
    }

    stateStore.setState({ isSavingAudio: true, errorMessage: null })

    let downloadUrl: string | null = null
    let anchor: HTMLAnchorElement | null = null

    try {
      const wavBlob = encodeWavMono16(displayedSlice.samples, displayedSlice.sampleRateHz)
      downloadUrl = URL.createObjectURL(wavBlob)
      anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = buildAudioFilename(new Date(), state.timeMinSec, state.timeMaxSec)
      anchor.style.display = 'none'
      document.body.append(anchor)
      anchor.click()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, '音声ファイルの保存に失敗しました。'),
      })
    } finally {
      if (anchor) {
        anchor.remove()
      }
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl)
      }
      if (stateStore.getState().isSavingAudio) {
        stateStore.setState({ isSavingAudio: false })
      }
    }
  }

  const resetToLiveModeState = (): void => {
    clearFileRenderThrottle()
    fileRenderInFlight = false
    pendingFileRenderAfterCurrent = false
    fileRenderSequence += 1
    fileAnalysisService.clear()

    const liveSampleRate = analysisService.getSampleRateHz()
    stateStore.setState({
      analysisSource: 'live',
      isLoadingFile: false,
      loadedAudioName: null,
      loadedAudioDurationSec: null,
      currentSampleRateHz: liveSampleRate,
      timeDomainMinSec: TIME_DOMAIN_MIN_SEC,
      timeDomainMaxSec: TIME_DOMAIN_MAX_SEC,
      timeMinSec: TIME_DOMAIN_MIN_SEC,
      timeMaxSec: TIME_DOMAIN_MAX_SEC,
    })
    syncTimelineState()
  }

  const applySnapshot = (snapshot: AnalysisSnapshot): void => {
    latestPcmWindow48k = snapshot.pcmWindow48k
    latestCapturedSamples48k = snapshot.capturedSamples48k
    stateStore.setState({
      analysisSource: 'live',
      currentSampleRateHz: snapshot.sampleRateHz,
    })
    timelineSyncState.sampleRateHz = snapshot.sampleRateHz
    timelineSyncState.windowSamples = Math.max(1, Math.round(snapshot.sampleRateHz * SPECTROGRAM_WINDOW_SECONDS))
    timelineSyncState.capturedSamples = snapshot.capturedSamples48k
    setHistoryFromLinear(snapshot.spectrogramHistory, snapshot.count, snapshot.bins)
    clampFftCursorsToActiveDomain()
    scheduleFftProfileRefresh(true, false)
  }

  const stopVisualization = async (): Promise<void> => {
    if (!stateStore.getState().isRecording) {
      if (captureChunkUnsubscribe) {
        captureChunkUnsubscribe()
        captureChunkUnsubscribe = null
      }
      return
    }

    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }

    try {
      const captureSnapshot = await audioEngine.requestWindowSnapshot()
      if (captureSnapshot) {
        // Triggered to flush pending worklet buffers into engine-side metrics.
      }
    } catch {
      // Ignore snapshot fetch errors and proceed to finalize worker data.
    }

    try {
      await audioEngine.stop()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, '停止処理に失敗しました。'),
      })
    }

    if (captureChunkUnsubscribe) {
      captureChunkUnsubscribe()
      captureChunkUnsubscribe = null
    }

    try {
      const finalizedSnapshot = await analysisService.stopAndFinalize()
      applySnapshot(finalizedSnapshot)
    } catch (error) {
      conservativeMode = true
      stateStore.setState({
        errorMessage: toErrorMessage(error, '停止後の再解析に失敗しました。'),
      })
    }

    stateStore.setState({
      isRecording: false,
      audioReady: false,
    })

    lastAnimationTimestamp = null
    resetAnalysisBuffers()
    requestHistoryRender()
  }

  const clearAllRecordedData = async (): Promise<void> => {
    if (stateStore.getState().isRecording) {
      await stopVisualization()
    }
    await stopPlayback()
    if (captureChunkUnsubscribe) {
      captureChunkUnsubscribe()
      captureChunkUnsubscribe = null
    }
    audioEngine.clearCapturedData()
    analysisService.clear()
    fileAnalysisService.clear()
    clearFileRenderThrottle()
    fileRenderInFlight = false
    pendingFileRenderAfterCurrent = false
    fileRenderSequence += 1
    latestPcmWindow48k = new Float32Array(0)
    latestCapturedSamples48k = 0
    timelineSyncState.capturedSamples = 0
    resetFrequencyHistory()
    resetAnalysisBuffers()
    renderer.clear()
    fftProfileState = null
    fftCursorState.lastFallbackNoticeKey = null
    stateStore.setState({
      analysisSource: 'live',
      isLoadingFile: false,
      loadedAudioName: null,
      loadedAudioDurationSec: null,
      currentSampleRateHz: analysisService.getSampleRateHz(),
      timeDomainMinSec: TIME_DOMAIN_MIN_SEC,
      timeDomainMaxSec: TIME_DOMAIN_MAX_SEC,
      timeMinSec: TIME_DOMAIN_MIN_SEC,
      timeMaxSec: TIME_DOMAIN_MAX_SEC,
      errorMessage: null,
    })
    syncTimelineState()
    scheduleFftProfileRefresh(true, false)
  }

  const loadLocalAudioFile = async (file: File): Promise<void> => {
    const currentState = stateStore.getState()
    if (currentState.isRecording || currentState.isPlayingBack || currentState.isSavingAudio || currentState.isLoadingFile) {
      stateStore.setState({ errorMessage: '停止中に音声ファイルを読み込んでください。' })
      return
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      stateStore.setState({ errorMessage: '有効な音声ファイルを選択してください。' })
      elements.loadAudioInput.value = ''
      return
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      stateStore.setState({
        errorMessage: `読み込めるファイルサイズは ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB までです。`,
      })
      elements.loadAudioInput.value = ''
      return
    }

    await stopVisualization()
    await stopPlayback()
    if (captureChunkUnsubscribe) {
      captureChunkUnsubscribe()
      captureChunkUnsubscribe = null
    }

    audioEngine.clearCapturedData()
    analysisService.clear()
    fileAnalysisService.clear()
    clearFileRenderThrottle()
    fileRenderInFlight = false
    pendingFileRenderAfterCurrent = false
    fileRenderSequence += 1
    pendingColumnQueue = []
    latestPcmWindow48k = new Float32Array(0)
    latestCapturedSamples48k = 0
    timelineSyncState.capturedSamples = 0
    resetFrequencyHistory()
    resetAnalysisBuffers()
    renderer.clear()
    fftProfileState = null
    fftCursorState.lastFallbackNoticeKey = null

    stateStore.setState({
      analysisSource: 'file',
      isLoadingFile: true,
      isRecording: false,
      audioReady: false,
      errorMessage: null,
    })

    try {
      const decoded = await decodeAudioFileToMono(file)
      if (!Number.isFinite(decoded.durationSec) || decoded.durationSec <= 0) {
        throw new Error('音声ファイルの長さを取得できませんでした。')
      }
      if (decoded.durationSec > MAX_FILE_DURATION_SECONDS) {
        throw new Error('読み込める音声長は30分までです。')
      }

      const loaded = await fileAnalysisService.loadFile(decoded.samples, decoded.sampleRateHz)
      const roundedDurationSec = Math.max(
        MIN_TIME_GAP_SEC,
        Math.round(loaded.durationSec / TIME_STEP_SEC) * TIME_STEP_SEC,
      )
      const domainMaxSec = Math.max(TIME_DOMAIN_MIN_SEC + MIN_TIME_GAP_SEC, roundedDurationSec)

      stateStore.setState({
        analysisSource: 'file',
        loadedAudioName: decoded.fileName,
        loadedAudioDurationSec: loaded.durationSec,
        currentSampleRateHz: loaded.sampleRateHz,
        timeDomainMinSec: TIME_DOMAIN_MIN_SEC,
        timeDomainMaxSec: domainMaxSec,
        timeMinSec: TIME_DOMAIN_MIN_SEC,
        timeMaxSec: domainMaxSec,
        isLoadingFile: true,
        errorMessage: null,
      })

      const refreshedState = stateStore.getState()
      const nextDomainMaxHz = Math.max(
        refreshedState.frequencyDomainMinHz + MIN_RANGE_GAP_HZ,
        roundToFrequencyStep(Math.floor(loaded.sampleRateHz / 2)),
      )
      const normalizedFrequency = normalizeFrequencyRange(
        refreshedState.frequencyMinHz,
        refreshedState.frequencyMaxHz,
        refreshedState.frequencyDomainMinHz,
        nextDomainMaxHz,
      )
      stateStore.setState({
        frequencyDomainMaxHz: nextDomainMaxHz,
        frequencyMinHz: normalizedFrequency.minHz,
        frequencyMaxHz: normalizedFrequency.maxHz,
      })

      clampFftCursorsToActiveDomain()
      syncTimelineState()
      requestFileWindowRender(true)
    } catch (error) {
      resetToLiveModeState()
      stateStore.setState({
        isLoadingFile: false,
        errorMessage: toErrorMessage(error, '音声ファイルの読み込みに失敗しました。'),
      })
    } finally {
      elements.loadAudioInput.value = ''
    }
  }

  const applyQualityProfile = (_reconfigureAnalysis: boolean, redrawHistory: boolean): void => {
    const qualityProfile = getActiveQualityProfile()
    elements.canvas.dataset.dprCap = String(qualityProfile.dprCap)
    applyRendererLayout()
    scheduleFftProfileRefresh(true, false)

    if (redrawHistory) {
      if (stateStore.getState().analysisSource === 'file') {
        requestFileWindowRender(true)
      } else {
        requestHistoryRender()
      }
    }
  }

  const updateQualityStageFromPerformance = (deltaMs: number): void => {
    frameTimeEmaMs = frameTimeEmaMs * 0.9 + deltaMs * 0.1

    if (!isMobileViewport()) {
      activeQualityStageIndex = 0
      aboveLevel1FrameCount = 0
      aboveLevel2FrameCount = 0
      belowRecoveryFrameCount = 0
      return
    }

    aboveLevel1FrameCount =
      frameTimeEmaMs > STAGE_DEGRADE_LEVEL1_FRAME_MS ? aboveLevel1FrameCount + 1 : 0
    aboveLevel2FrameCount =
      frameTimeEmaMs > STAGE_DEGRADE_LEVEL2_FRAME_MS ? aboveLevel2FrameCount + 1 : 0
    belowRecoveryFrameCount = frameTimeEmaMs < STAGE_UPGRADE_FRAME_MS ? belowRecoveryFrameCount + 1 : 0

    const currentStage = activeQualityStageIndex
    let nextStage = currentStage

    if (
      currentStage < MOBILE_QUALITY_PROFILES.length - 1 &&
      aboveLevel2FrameCount >= STAGE_DEGRADE_REQUIRED_FRAMES
    ) {
      nextStage = MOBILE_QUALITY_PROFILES.length - 1
    } else if (currentStage === 0 && aboveLevel1FrameCount >= STAGE_DEGRADE_REQUIRED_FRAMES) {
      nextStage = 1
    } else if (currentStage > 0 && belowRecoveryFrameCount >= STAGE_UPGRADE_REQUIRED_FRAMES) {
      nextStage = currentStage - 1
    }

    if (nextStage === currentStage) {
      return
    }

    activeQualityStageIndex = nextStage
    aboveLevel1FrameCount = 0
    aboveLevel2FrameCount = 0
    belowRecoveryFrameCount = 0
    applyQualityProfile(true, true)
  }

  const renderProjectedColumn = (state: AppState, rawFrequencyData: Float32Array): void => {
    appendHistoryColumn(rawFrequencyData)

    const fullTimeSpan = Math.max(MIN_TIME_GAP_SEC, state.timeDomainMaxSec - state.timeDomainMinSec)
    const selectedTimeSpan = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    const usesTimeZoom = selectedTimeSpan < fullTimeSpan - 1e-6
    if (usesTimeZoom) {
      requestHistoryRender()
      scheduleFftProfileRefresh(false, false)
      return
    }

    const nyquistHz = Math.max(state.frequencyDomainMaxHz, timelineSyncState.sampleRateHz / 2)
    const projectedFrequencyData = projectFrequencyRange(
      rawFrequencyData,
      state.frequencyMinHz,
      state.frequencyMaxHz,
      nyquistHz,
    )
    renderer.drawColumn(projectedFrequencyData, state.decibelMin, state.decibelMax, state.colormapId)
    scheduleFftProfileRefresh(false, false)
  }

  const drawFrame = (timestamp: number): void => {
    const state = stateStore.getState()
    if (!state.isRecording) {
      frameId = null
      return
    }

    if (lastAnimationTimestamp === null) {
      lastAnimationTimestamp = timestamp
    }

    const deltaMs = Math.max(0, timestamp - lastAnimationTimestamp)
    const deltaSeconds = deltaMs / 1000
    lastAnimationTimestamp = timestamp
    updateQualityStageFromPerformance(deltaMs)

    renderGateAccumulatorSeconds += deltaSeconds

    const qualityProfile = getActiveQualityProfile()
    const maxColumnsPerFrame = Math.max(1, qualityProfile.maxColumnsPerFrame * 4)

    const renderIntervalSeconds = 1 / Math.max(1, qualityProfile.renderFps)
    if (renderGateAccumulatorSeconds < renderIntervalSeconds) {
      frameId = requestAnimationFrame(drawFrame)
      return
    }

    renderGateAccumulatorSeconds %= renderIntervalSeconds

    let columnsDrawn = 0
    while (columnsDrawn < maxColumnsPerFrame) {
      const columnData = consumeColumnData()
      if (!columnData) {
        break
      }
      renderProjectedColumn(state, columnData)
      columnsDrawn += 1
    }

    frameId = requestAnimationFrame(drawFrame)
  }

  const render = (state: AppState): void => {
    if (renderer.getPlotMetrics().plotWidth <= 1) {
      applyQualityProfile(false, false)
    }

    const hasSavableAudio = hasSavableAudioData()
    renderControlsView(elements, state, hasSavableAudio)
    renderPlaybackWidget(state, hasSavableAudio)
    elements.analysisMetrics.textContent = formatAnalysisMetricsText(
      Math.max(1, state.currentSampleRateHz ?? timelineSyncState.sampleRateHz),
      state.analysisFrameSize,
    )
    renderAnalysisControls(state)
    renderFrequencyControls(state)
    renderDecibelControls(state)
    renderTimeControls(state)
    renderDecibelTicks(state.decibelMin, state.decibelMax)
    renderColormapControl(state)
    updateAxisConfig(state)
    elements.fftAverageToggleButton.disabled = false
    elements.fftAverageToggleButton.classList.toggle('is-active', fftCursorState.mode === 'average')

    const frequencyRangeChanged =
      lastRenderedRangeMinHz !== state.frequencyMinHz || lastRenderedRangeMaxHz !== state.frequencyMaxHz
    const decibelRangeChanged =
      lastRenderedDecibelMin !== state.decibelMin || lastRenderedDecibelMax !== state.decibelMax
    const colormapChanged = lastRenderedColormapId !== state.colormapId
    const timeRangeChanged = lastRenderedTimeMinSec !== state.timeMinSec || lastRenderedTimeMaxSec !== state.timeMaxSec
    const analysisConfigChanged =
      lastRenderedFrameSize !== state.analysisFrameSize ||
      lastRenderedOverlapPercent !== state.analysisOverlapPercent ||
      lastRenderedUpperFrequencyHz !== state.analysisUpperFrequencyHz
    if (frequencyRangeChanged || decibelRangeChanged || colormapChanged || timeRangeChanged) {
      const needsFileWindowRender = state.analysisSource === 'file' && (frequencyRangeChanged || timeRangeChanged)
      if (needsFileWindowRender) {
        requestFileWindowRender(false)
      } else {
        requestHistoryRender()
      }
      lastRenderedRangeMinHz = state.frequencyMinHz
      lastRenderedRangeMaxHz = state.frequencyMaxHz
      lastRenderedDecibelMin = state.decibelMin
      lastRenderedDecibelMax = state.decibelMax
      lastRenderedColormapId = state.colormapId
      lastRenderedTimeMinSec = state.timeMinSec
      lastRenderedTimeMaxSec = state.timeMaxSec
    }
    if (analysisConfigChanged) {
      lastRenderedFrameSize = state.analysisFrameSize
      lastRenderedOverlapPercent = state.analysisOverlapPercent
      lastRenderedUpperFrequencyHz = state.analysisUpperFrequencyHz
      if (state.analysisSource === 'file') {
        requestFileWindowRender(true)
      }
      scheduleFftProfileRefresh(true, false)
    }

    updateCursorOverlay(state)
    renderFftPanel(state)

    if (state.errorMessage) {
      const isTopPopupMessage = state.errorMessage === NO_REAL_DATA_RANGE_MESSAGE
      elements.errorMessage.classList.toggle('error-top-popup', isTopPopupMessage)
      elements.errorMessage.hidden = false
      elements.errorMessage.textContent = state.errorMessage
    } else {
      elements.errorMessage.classList.remove('error-top-popup')
      elements.errorMessage.hidden = true
      elements.errorMessage.textContent = ''
    }
  }

  buildColormapPopover()
  stateStore.subscribe(render)

  elements.dbColorbar.addEventListener('click', () => {
    const nextOpen = !isColormapPopoverOpen
    setColormapPopoverOpen(nextOpen, nextOpen)
  })

  document.addEventListener('pointerdown', (event) => {
    if (!isColormapPopoverOpen || !(event.target instanceof Node)) {
      return
    }

    if (elements.dbColorbar.contains(event.target) || elements.colormapPopover.contains(event.target)) {
      return
    }

    setColormapPopoverOpen(false)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isColormapPopoverOpen) {
      return
    }

    event.preventDefault()
    setColormapPopoverOpen(false)
    elements.dbColorbar.focus()
  })

  elements.frameSizeSelect.addEventListener('change', () => {
    const state = stateStore.getState()
    if (state.isRecording) {
      elements.frameSizeSelect.value = String(state.analysisFrameSize)
      return
    }

    const parsedFrameSize = parseFrameSizeInput(elements.frameSizeSelect.value)
    if (parsedFrameSize === null) {
      elements.frameSizeSelect.value = String(state.analysisFrameSize)
      return
    }

    if (parsedFrameSize === state.analysisFrameSize) {
      return
    }

    stateStore.setState({ analysisFrameSize: parsedFrameSize })
    const refreshedState = stateStore.getState()
    if (refreshedState.analysisSource === 'file') {
      requestFileWindowRender(true)
      return
    }
    analysisService.start({
      frameSize: refreshedState.analysisFrameSize,
      overlapPercent: refreshedState.analysisOverlapPercent,
      plotWidth: Math.max(1, getHistoryCapacity()),
    })
    void syncHistoryFromWorker()
  })

  elements.upperFrequencySelect.addEventListener('change', () => {
    const state = stateStore.getState()
    if (state.isRecording) {
      elements.upperFrequencySelect.value = String(state.analysisUpperFrequencyHz)
      return
    }

    const parsedUpperFrequencyHz = parseUpperFrequencyInput(elements.upperFrequencySelect.value)
    if (parsedUpperFrequencyHz === null) {
      elements.upperFrequencySelect.value = String(state.analysisUpperFrequencyHz)
      return
    }

    if (parsedUpperFrequencyHz === state.analysisUpperFrequencyHz) {
      return
    }

    stateStore.setState({ analysisUpperFrequencyHz: parsedUpperFrequencyHz })
  })

  elements.overlapInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    commitOverlapInput()
    elements.overlapInput.blur()
  })

  elements.dbMinInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    commitDecibelInput('min')
    elements.dbMinInput.blur()
  })

  elements.dbMaxInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    commitDecibelInput('max')
    elements.dbMaxInput.blur()
  })

  elements.freqMinInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitFrequencyInput('min')
      elements.freqMinInput.blur()
    }
  })

  elements.freqMaxInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitFrequencyInput('max')
      elements.freqMaxInput.blur()
    }
  })

  elements.timeMinInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTimeInput('min')
      elements.timeMinInput.blur()
    }
  })

  elements.timeMaxInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTimeInput('max')
      elements.timeMaxInput.blur()
    }
  })

  const beginFrequencySliderDrag = (target: DragHandle, event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile || (conservativeMode && state.isRecording)) {
      return
    }

    freqDragHandle = target
    freqDragPointerId = event.pointerId
    elements.freqSlider.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    applySliderClientY(event.clientY, target)
  }

  const endFrequencySliderDrag = (event: PointerEvent): void => {
    if (freqDragPointerId !== event.pointerId) {
      return
    }

    freqDragHandle = null
    freqDragPointerId = null
    if (elements.freqSlider.hasPointerCapture(event.pointerId)) {
      elements.freqSlider.releasePointerCapture(event.pointerId)
    }
  }

  elements.freqHandleMin.addEventListener('pointerdown', (event) => {
    beginFrequencySliderDrag('min', event)
  })

  elements.freqHandleMax.addEventListener('pointerdown', (event) => {
    beginFrequencySliderDrag('max', event)
  })

  elements.freqSlider.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLButtonElement) {
      return
    }

    const state = stateStore.getState()
    const rect = elements.freqSlider.getBoundingClientRect()
    if (rect.height <= 0) {
      return
    }

    const ratio = clamp((event.clientY - rect.top) / rect.height, 0, 1)
    const clickedHz = fromSliderRatio(ratio, state.frequencyDomainMinHz, state.frequencyDomainMaxHz)
    const distanceToMin = Math.abs(clickedHz - state.frequencyMinHz)
    const distanceToMax = Math.abs(clickedHz - state.frequencyMaxHz)
    beginFrequencySliderDrag(distanceToMax <= distanceToMin ? 'max' : 'min', event)
  })

  elements.freqSlider.addEventListener('pointermove', (event) => {
    if (!freqDragHandle || freqDragPointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    applySliderClientY(event.clientY, freqDragHandle)
  })

  elements.freqSlider.addEventListener('pointerup', endFrequencySliderDrag)
  elements.freqSlider.addEventListener('pointercancel', endFrequencySliderDrag)

  const beginDecibelSliderDrag = (target: DragHandle, event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile || (conservativeMode && state.isRecording)) {
      return
    }

    dbDragHandle = target
    dbDragPointerId = event.pointerId
    elements.dbSlider.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    applyDecibelSliderClientY(event.clientY, target)
  }

  const endDecibelSliderDrag = (event: PointerEvent): void => {
    if (dbDragPointerId !== event.pointerId) {
      return
    }

    dbDragHandle = null
    dbDragPointerId = null
    if (elements.dbSlider.hasPointerCapture(event.pointerId)) {
      elements.dbSlider.releasePointerCapture(event.pointerId)
    }
  }

  elements.dbHandleMin.addEventListener('pointerdown', (event) => {
    beginDecibelSliderDrag('min', event)
  })

  elements.dbHandleMax.addEventListener('pointerdown', (event) => {
    beginDecibelSliderDrag('max', event)
  })

  elements.dbSlider.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLButtonElement) {
      return
    }

    const state = stateStore.getState()
    const rect = elements.dbSlider.getBoundingClientRect()
    if (rect.height <= 0) {
      return
    }

    const ratio = clamp((event.clientY - rect.top) / rect.height, 0, 1)
    const clickedDb = fromDecibelSliderRatio(ratio, DECIBEL_INPUT_MIN, DECIBEL_INPUT_MAX)
    const distanceToMin = Math.abs(clickedDb - state.decibelMin)
    const distanceToMax = Math.abs(clickedDb - state.decibelMax)
    beginDecibelSliderDrag(distanceToMax <= distanceToMin ? 'max' : 'min', event)
  })

  elements.dbSlider.addEventListener('pointermove', (event) => {
    if (!dbDragHandle || dbDragPointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    applyDecibelSliderClientY(event.clientY, dbDragHandle)
  })

  elements.dbSlider.addEventListener('pointerup', endDecibelSliderDrag)
  elements.dbSlider.addEventListener('pointercancel', endDecibelSliderDrag)

  const beginTimeSliderDrag = (target: DragHandle, event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.isPlayingBack || state.isRecording || state.isLoadingFile || conservativeMode) {
      return
    }

    timeDragHandle = target
    timeDragPointerId = event.pointerId
    elements.timeSlider.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    applyTimeSliderClientX(event.clientX, target)
  }

  const endTimeSliderDrag = (event: PointerEvent): void => {
    if (timeDragPointerId !== event.pointerId) {
      return
    }

    timeDragHandle = null
    timeDragPointerId = null
    if (elements.timeSlider.hasPointerCapture(event.pointerId)) {
      elements.timeSlider.releasePointerCapture(event.pointerId)
    }
  }

  elements.timeHandleMin.addEventListener('pointerdown', (event) => {
    beginTimeSliderDrag('min', event)
  })

  elements.timeHandleMax.addEventListener('pointerdown', (event) => {
    beginTimeSliderDrag('max', event)
  })

  elements.timeSlider.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLButtonElement) {
      return
    }

    const state = stateStore.getState()
    if (state.isPlayingBack || state.isRecording || state.isLoadingFile || conservativeMode) {
      return
    }
    const rect = elements.timeSlider.getBoundingClientRect()
    if (rect.width <= 0) {
      return
    }

    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const clickedSec = fromTimeSliderRatio(ratio, state.timeDomainMinSec, state.timeDomainMaxSec)
    const distanceToMin = Math.abs(clickedSec - state.timeMinSec)
    const distanceToMax = Math.abs(clickedSec - state.timeMaxSec)
    beginTimeSliderDrag(distanceToMax <= distanceToMin ? 'max' : 'min', event)
  })

  elements.timeSlider.addEventListener('pointermove', (event) => {
    if (!timeDragHandle || timeDragPointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    applyTimeSliderClientX(event.clientX, timeDragHandle)
  })

  elements.timeSlider.addEventListener('pointerup', endTimeSliderDrag)
  elements.timeSlider.addEventListener('pointercancel', endTimeSliderDrag)

  const toggleAverageFftMode = (enable: boolean): void => {
    const state = stateStore.getState()
    const cursorBounds = getSpectrogramCursorBoundsSec(state)
    if (!cursorBounds.hasData) {
      stateStore.setState({ errorMessage: '実データがないためカーソル操作できません。' })
      return
    }

    if (enable) {
      const minimumRangeSec = getMinimumCursorRangeSec(state)
      const range = ensureAverageCursorRange(state, fftCursorState.singleSec, minimumRangeSec)
      fftCursorState.mode = 'average'
      fftCursorState.rangeMinSec = range.minSec
      fftCursorState.rangeMaxSec = range.maxSec
      if (range.impossible) {
        showFallbackNoticeIfNeeded(minimumRangeSec, 'impossible', true)
      }
      scheduleFftProfileRefresh(true, true)
      return
    }

    const midpointSec = clampSpectrogramCursorSecToLiveData(
      (fftCursorState.rangeMinSec + fftCursorState.rangeMaxSec) / 2,
      state,
    )
    fftCursorState.mode = 'single'
    fftCursorState.singleSec = midpointSec
    fftCursorState.lastFallbackNoticeKey = null
    scheduleFftProfileRefresh(true, false)
  }

  const getNearTapThresholdCssPx = (): number =>
    isMobileViewport() ? CURSOR_NEAR_TAP_THRESHOLD_MOBILE_PX : CURSOR_NEAR_TAP_THRESHOLD_DESKTOP_PX

  const resolveCanvasPointerX = (clientX: number, rect: DOMRect, dpr: number): number => {
    return (clientX - rect.left) * Math.max(1, dpr)
  }

  const getTapSecondFromPointer = (
    state: AppState,
    metrics: PlotMetrics,
    pointerX: number,
  ): number => {
    if (metrics.plotWidth <= 0) {
      return clampSpectrogramCursorSecToLiveData(state.timeMinSec, state)
    }

    const ratio = clamp((pointerX - metrics.plotX) / metrics.plotWidth, 0, 1)
    const visibleSpanSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    return clampSpectrogramCursorSecToLiveData(state.timeMinSec + ratio * visibleSpanSec, state)
  }

  const buildCursorCandidate = (
    state: AppState,
    metrics: PlotMetrics,
    pointerX: number,
    tapSec: number,
    handle: FftCursorDragHandle,
    seconds: number,
  ): CursorCandidate => {
    const visibleSpanSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    const visibleMinSec = state.timeMinSec
    const visibleMaxSec = state.timeMaxSec
    const visible = seconds >= visibleMinSec && seconds <= visibleMaxSec
    const ratio = clamp((seconds - visibleMinSec) / visibleSpanSec, 0, 1)
    const cursorX = metrics.plotX + ratio * metrics.plotWidth
    return {
      handle,
      seconds,
      visible,
      distancePx: visible ? Math.abs(pointerX - cursorX) : Number.POSITIVE_INFINITY,
      distanceSec: Math.abs(seconds - tapSec),
    }
  }

  const resolveFftTapTargetHandle = (
    state: AppState,
    metrics: PlotMetrics,
    pointerX: number,
    tapSec: number,
  ): FftCursorDragHandle | null => {
    const candidates: CursorCandidate[] = []
    if (fftCursorState.mode === 'single') {
      candidates.push(buildCursorCandidate(state, metrics, pointerX, tapSec, 'single', fftCursorState.singleSec))
      return candidates[0]?.handle ?? null
    }

    candidates.push(buildCursorCandidate(state, metrics, pointerX, tapSec, 'min', fftCursorState.rangeMinSec))
    candidates.push(buildCursorCandidate(state, metrics, pointerX, tapSec, 'max', fftCursorState.rangeMaxSec))

    const compareByDistancePxThenSec = (a: CursorCandidate, b: CursorCandidate): number => {
      if (a.distancePx !== b.distancePx) {
        return a.distancePx - b.distancePx
      }
      return a.distanceSec - b.distanceSec
    }
    const compareByDistanceSecThenPx = (a: CursorCandidate, b: CursorCandidate): number => {
      if (a.distanceSec !== b.distanceSec) {
        return a.distanceSec - b.distanceSec
      }
      return a.distancePx - b.distancePx
    }

    const nearTapThresholdPx = getNearTapThresholdCssPx() * Math.max(1, metrics.dpr)
    const visibleNearCandidates = candidates.filter(
      (candidate) => candidate.visible && candidate.distancePx <= nearTapThresholdPx,
    )
    if (visibleNearCandidates.length > 0) {
      visibleNearCandidates.sort(compareByDistancePxThenSec)
      return visibleNearCandidates[0]?.handle ?? null
    }

    const invisibleCandidates = candidates.filter((candidate) => !candidate.visible)
    if (invisibleCandidates.length > 0) {
      invisibleCandidates.sort(compareByDistanceSecThenPx)
      return invisibleCandidates[0]?.handle ?? null
    }

    const nearestCandidates = [...candidates].sort(compareByDistancePxThenSec)
    return nearestCandidates[0]?.handle ?? null
  }

  const moveFftCursorToSec = (handle: FftCursorDragHandle, seconds: number): void => {
    const state = stateStore.getState()
    const safeSeconds = clampSpectrogramCursorSecToLiveData(seconds, state)
    if (fftCursorState.mode === 'single' || handle === 'single') {
      fftCursorState.singleSec = safeSeconds
      return
    }

    if (handle === 'min') {
      if (safeSeconds <= fftCursorState.rangeMaxSec) {
        fftCursorState.rangeMinSec = safeSeconds
        return
      }

      const previousMaxSec = fftCursorState.rangeMaxSec
      fftCursorState.rangeMinSec = previousMaxSec
      fftCursorState.rangeMaxSec = safeSeconds
      if (fftCursorState.activeDragHandle === 'min') {
        fftCursorState.activeDragHandle = 'max'
      }
      return
    }

    if (safeSeconds >= fftCursorState.rangeMinSec) {
      fftCursorState.rangeMaxSec = safeSeconds
      return
    }

    const previousMinSec = fftCursorState.rangeMinSec
    fftCursorState.rangeMaxSec = previousMinSec
    fftCursorState.rangeMinSec = safeSeconds
    if (fftCursorState.activeDragHandle === 'max') {
      fftCursorState.activeDragHandle = 'min'
    }
  }

  const beginFftCursorDrag = (event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile) {
      return
    }
    const cursorBounds = getSpectrogramCursorBoundsSec(state)
    if (!cursorBounds.hasData) {
      stateStore.setState({ errorMessage: '実データがないためカーソル操作できません。' })
      return
    }

    const metrics = renderer.getPlotMetrics()
    if (metrics.plotWidth <= 0 || metrics.plotHeight <= 0) {
      return
    }

    const rect = elements.canvas.getBoundingClientRect()
    const pointerX = resolveCanvasPointerX(event.clientX, rect, metrics.dpr)
    const tapSeconds = getTapSecondFromPointer(state, metrics, pointerX)
    const targetHandle = resolveFftTapTargetHandle(state, metrics, pointerX, tapSeconds)
    if (!targetHandle) {
      return
    }

    fftCursorState.activeDragHandle = targetHandle
    fftCursorState.activePointerId = event.pointerId
    elements.canvas.setPointerCapture(event.pointerId)
    moveFftCursorToSec(targetHandle, tapSeconds)
    scheduleFftProfileRefresh(false, false)
    updateCursorOverlay(state)
    event.preventDefault()
    event.stopPropagation()
  }

  const applyFftCursorDrag = (event: PointerEvent): void => {
    if (fftCursorState.activePointerId !== event.pointerId || !fftCursorState.activeDragHandle) {
      return
    }

    const state = stateStore.getState()
    const metrics = renderer.getPlotMetrics()
    const rect = elements.canvas.getBoundingClientRect()
    if (metrics.plotWidth <= 0 || rect.width <= 0) {
      return
    }

    const pointerX = resolveCanvasPointerX(event.clientX, rect, metrics.dpr)
    const nextSec = getTapSecondFromPointer(state, metrics, pointerX)
    moveFftCursorToSec(fftCursorState.activeDragHandle, nextSec)

    scheduleFftProfileRefresh(false, false)
    updateCursorOverlay(state)
  }

  const endFftCursorDrag = (event: PointerEvent): void => {
    if (fftCursorState.activePointerId !== event.pointerId) {
      return
    }

    fftCursorState.activeDragHandle = null
    fftCursorState.activePointerId = null
    if (elements.canvas.hasPointerCapture(event.pointerId)) {
      elements.canvas.releasePointerCapture(event.pointerId)
    }
    scheduleFftProfileRefresh(true, true)
  }

  const resolveFftPlotCursorFrequencyFromPointer = (event: PointerEvent, state: AppState): number | null => {
    const metrics = resizeFftCanvas()
    const rect = elements.fftCanvas.getBoundingClientRect()
    if (metrics.plotWidth <= 0 || rect.width <= 0) {
      return null
    }

    const pointerX = resolveCanvasPointerX(event.clientX, rect, metrics.dpr)
    const ratio = clamp((pointerX - metrics.plotX) / metrics.plotWidth, 0, 1)
    const bounds = getFftFrequencyBounds(state)
    return bounds.minHz + ratio * bounds.spanHz
  }

  const beginFftPlotCursorDrag = (event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.isLoadingFile || state.isRecording) {
      return
    }

    const nextHz = resolveFftPlotCursorFrequencyFromPointer(event, state)
    if (nextHz === null) {
      return
    }

    fftPlotCursorHz = nextHz
    fftPlotCursorPointerId = event.pointerId
    elements.fftCanvas.setPointerCapture(event.pointerId)
    renderFftPanel(state)
    event.preventDefault()
    event.stopPropagation()
  }

  const applyFftPlotCursorDrag = (event: PointerEvent): void => {
    if (fftPlotCursorPointerId !== event.pointerId) {
      return
    }

    const state = stateStore.getState()
    if (state.isRecording) {
      return
    }

    const nextHz = resolveFftPlotCursorFrequencyFromPointer(event, state)
    if (nextHz === null) {
      return
    }

    fftPlotCursorHz = nextHz
    renderFftPanel(state)
  }

  const endFftPlotCursorDrag = (event: PointerEvent): void => {
    if (fftPlotCursorPointerId !== event.pointerId) {
      return
    }

    fftPlotCursorPointerId = null
    if (elements.fftCanvas.hasPointerCapture(event.pointerId)) {
      elements.fftCanvas.releasePointerCapture(event.pointerId)
    }
  }

  elements.fftAverageToggleButton.addEventListener('click', () => {
    toggleAverageFftMode(fftCursorState.mode !== 'average')
  })

  elements.canvas.addEventListener('pointerdown', (event) => {
    beginFftCursorDrag(event)
  })
  elements.canvas.addEventListener('pointermove', (event) => {
    if (fftCursorState.activePointerId !== event.pointerId) {
      return
    }
    event.preventDefault()
    applyFftCursorDrag(event)
  })
  elements.canvas.addEventListener('pointerup', endFftCursorDrag)
  elements.canvas.addEventListener('pointercancel', endFftCursorDrag)
  elements.fftCanvas.addEventListener('pointerdown', (event) => {
    beginFftPlotCursorDrag(event)
  })
  elements.fftCanvas.addEventListener('pointermove', (event) => {
    if (fftPlotCursorPointerId !== event.pointerId) {
      return
    }
    event.preventDefault()
    applyFftPlotCursorDrag(event)
  })
  elements.fftCanvas.addEventListener('pointerup', endFftPlotCursorDrag)
  elements.fftCanvas.addEventListener('pointercancel', endFftPlotCursorDrag)

  elements.loadAudioButton.addEventListener('click', () => {
    const state = stateStore.getState()
    if (state.isRecording || state.isPlayingBack || state.isSavingAudio || state.isLoadingFile) {
      stateStore.setState({ errorMessage: '停止中に音声ファイルを読み込んでください。' })
      return
    }

    stateStore.setState({ errorMessage: null })
    elements.loadAudioInput.value = ''
    elements.loadAudioInput.click()
  })

  elements.loadAudioInput.addEventListener('change', () => {
    const selectedFile = elements.loadAudioInput.files?.[0]
    if (!selectedFile) {
      return
    }
    void loadLocalAudioFile(selectedFile)
  })

  elements.startButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    const state = stateStore.getState()
    if (state.isRecording) {
      await stopVisualization()
      return
    }

    if (state.isPlayingBack) {
      stateStore.setState({ errorMessage: '再生中です。Playボタンで停止してからRecordしてください。' })
      return
    }

    if (state.isSavingAudio) {
      stateStore.setState({ errorMessage: '保存処理中です。完了後に再度Recordしてください。' })
      return
    }
    if (state.isLoadingFile) {
      stateStore.setState({ errorMessage: '音声ファイルの読み込み完了後にRecordしてください。' })
      return
    }

    try {
      await stopPlayback()
      if (state.analysisSource === 'file') {
        resetToLiveModeState()
        latestPcmWindow48k = new Float32Array(0)
        latestCapturedSamples48k = 0
        timelineSyncState.capturedSamples = 0
        resetFrequencyHistory()
        resetAnalysisBuffers()
        renderer.clear()
      }
      const liveState = stateStore.getState()
      const currentPlotWidth = Math.max(1, getHistoryCapacity())
      analysisService.start({
        frameSize: liveState.analysisFrameSize,
        overlapPercent: liveState.analysisOverlapPercent,
        plotWidth: currentPlotWidth,
      })
      syncTimelineState()
      if (captureChunkUnsubscribe) {
        captureChunkUnsubscribe()
      }
      captureChunkUnsubscribe = audioEngine.subscribeCaptureChunk((chunk: CaptureChunk) => {
        analysisService.pushCaptureChunk(chunk)
      })
      await audioEngine.start({
        fftSize: liveState.analysisFrameSize,
        upperFrequencyHz: liveState.analysisUpperFrequencyHz,
      })
      conservativeMode = false
      resetAnalysisBuffers()
      lastAnimationTimestamp = null
      activeQualityStageIndex = 0
      applyQualityProfile(false, false)

      const nyquistFrequencyHz = analysisService.getSampleRateHz() / 2
      const detectedMaxFrequencyHz = Math.min(nyquistFrequencyHz, liveState.analysisUpperFrequencyHz)
      setFrequencyDomainMax(detectedMaxFrequencyHz)

      stateStore.setState({
        analysisSource: 'live',
        isRecording: true,
        hasMicPermission: true,
        audioReady: true,
        currentSampleRateHz: analysisService.getSampleRateHz(),
      })
      scheduleFftProfileRefresh(true, false)

      frameId = requestAnimationFrame(drawFrame)
      void syncHistoryFromWorker()
    } catch (error) {
      conservativeMode = true
      stateStore.setState({
        errorMessage: isMicrophonePermissionError(error)
          ? 'マイク権限が拒否されました。ブラウザ設定を確認してください。'
          : toErrorMessage(error, 'AudioContextの開始に失敗しました。'),
        isRecording: false,
        hasMicPermission: false,
        audioReady: false,
      })
      if (captureChunkUnsubscribe) {
        captureChunkUnsubscribe()
        captureChunkUnsubscribe = null
      }
      await audioEngine.stop().catch(() => undefined)
      scheduleFftProfileRefresh(true, false)
    }
  })

  elements.clearButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })
    const state = stateStore.getState()
    if (state.isSavingAudio || state.isPlayingBack || state.isRecording || state.isLoadingFile) {
      stateStore.setState({ errorMessage: '停止中にClearを実行してください。' })
      return
    }

    try {
      await clearAllRecordedData()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, 'データのクリアに失敗しました。'),
      })
    }
  })

  elements.playbackToggleButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    const state = stateStore.getState()
    if (state.isSavingAudio || state.isLoadingFile) {
      stateStore.setState({ errorMessage: '保存処理中です。完了後に再生できます。' })
      return
    }

    try {
      if (state.isPlayingBack) {
        await stopPlayback()
        return
      }
      await startPlayback()
    } catch (error) {
      await stopPlayback()
      stateStore.setState({
        errorMessage: toErrorMessage(error, '音声再生に失敗しました。'),
      })
    }
  })

  elements.saveButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    const state = stateStore.getState()
    if (state.isRecording || state.isPlayingBack || state.isLoadingFile) {
      stateStore.setState({ errorMessage: '停止後に表示範囲を保存できます。' })
      return
    }

    if (!hasSavableAudioData()) {
      stateStore.setState({ errorMessage: '保存可能な録音データがありません。' })
      return
    }

    try {
      await saveDisplayedAudio()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, '音声ファイルの保存に失敗しました。'),
      })
    }
  })

  window.addEventListener('popstate', () => {
    normalizeRecordingRoute()
  })

  window.addEventListener('beforeunload', () => {
    if (analysisColumnsUnsubscribe) {
      analysisColumnsUnsubscribe()
      analysisColumnsUnsubscribe = null
    }
    if (captureChunkUnsubscribe) {
      captureChunkUnsubscribe()
      captureChunkUnsubscribe = null
    }

    if (resizeObserver) {
      resizeObserver.disconnect()
    }
    if (fftRefreshTimeoutId !== null) {
      window.clearTimeout(fftRefreshTimeoutId)
      fftRefreshTimeoutId = null
    }
    clearFileRenderThrottle()

    void stopVisualization()
    void stopPlayback()
    analysisService.dispose()
    fileAnalysisService.dispose()
  })

  let resizeRafId: number | null = null
  const scheduleLayoutRefresh = (): void => {
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId)
    }

    resizeRafId = requestAnimationFrame(() => {
      applyQualityProfile(false, false)
      requestHistoryRender()
      resizeRafId = null
    })
  }

  resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          scheduleLayoutRefresh()
        })
      : null

  if (resizeObserver) {
    resizeObserver.observe(elements.canvas)
    resizeObserver.observe(elements.fftCanvas)
  }

  window.addEventListener('resize', () => {
    scheduleLayoutRefresh()
  })

  document.addEventListener('visibilitychange', () => {
    const state = stateStore.getState()

    if (document.hidden) {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
        frameId = null
      }

      lastAnimationTimestamp = null
      renderGateAccumulatorSeconds = 0
      return
    }

    scheduleLayoutRefresh()

    if (state.isRecording && frameId === null) {
      lastAnimationTimestamp = null
      frameId = requestAnimationFrame(drawFrame)
    }
  })
}
