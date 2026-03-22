import { createAudioEngine, type CaptureChunk } from '../audio/audioEngine'
import { createAnalysisService, type AnalysisSnapshot } from '../audio/analysisService'
import { createAppStateStore } from './state'
import { getFirebaseConfig } from '../firebase/config'
import { createAuthService } from '../firebase/auth'
import { initFirebase } from '../firebase/init'
import {
  createRenderer,
  type AxisRenderConfig,
  type CursorOverlayConfig,
  type PlotMetrics,
} from '../render/canvas'
import { renderAuthView } from '../ui/authView'
import { renderControlsView } from '../ui/controlsView'
import { getUIElements } from '../ui/dom'
import { isMicrophonePermissionError, toErrorMessage } from '../utils/errors'
import { Circle, createElement as createLucideElement, Download, Eraser, Play, Square } from 'lucide'
import type { AppState, AuthStatus, FrameSize, UpperFrequencyHz } from './types'

const SPECTROGRAM_WINDOW_SECONDS = 10
const TIME_DOMAIN_MIN_SEC = 0
const TIME_DOMAIN_MAX_SEC = 10
const FREQUENCY_DOMAIN_MIN_HZ = 0
const DEFAULT_MAX_FREQUENCY_HZ = 22050
const FREQUENCY_TICK_COUNT = 6
const TIME_TICK_COUNT = 6
const LOGIN_PATH = '/login'
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
const CURSOR_HIT_TEST_PX = 10
const FFT_RENDER_SMOOTH_ALPHA = 0.35

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

type AppRoute = 'login' | 'recording'
type HistoryMode = 'push' | 'replace'
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

function routeToPath(route: AppRoute): string {
  return route === 'recording' ? RECORDING_PATH : LOGIN_PATH
}

function routeFromPath(pathname: string): AppRoute {
  return pathname === RECORDING_PATH ? 'recording' : 'login'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
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
  const elements = getUIElements()
  const stateStore = createAppStateStore({
    analysisFrameSize: DEFAULT_ANALYSIS_FRAME_SIZE,
    analysisOverlapPercent: DEFAULT_ANALYSIS_OVERLAP_PERCENT,
    analysisUpperFrequencyHz: DEFAULT_ANALYSIS_UPPER_FREQUENCY_HZ,
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
  const renderer = createRenderer()
  renderer.init(elements.canvas)
  const fftCanvasCtx = elements.fftCanvas.getContext('2d')
  if (!fftCanvasCtx) {
    throw new Error('Failed to initialize FFT canvas context.')
  }

  let authUnsubscribe: (() => void) | null = null
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
  let lastAuthStatus: AuthStatus | null = null
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

  const getMinimumCursorRangeSec = (state: AppState): number => {
    const sampleRateHz = Math.max(1, timelineSyncState.sampleRateHz)
    return state.analysisFrameSize / sampleRateHz
  }

  const clampCursorSeconds = (seconds: number): number => {
    return clamp(seconds, TIME_DOMAIN_MIN_SEC, TIME_DOMAIN_MAX_SEC)
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
    singleSec: number,
    minimumRangeSec: number,
  ): { minSec: number; maxSec: number; impossible: boolean } => {
    const safeSingleSec = clampCursorSeconds(singleSec)
    if (!Number.isFinite(minimumRangeSec) || minimumRangeSec > SPECTROGRAM_WINDOW_SECONDS) {
      return {
        minSec: safeSingleSec,
        maxSec: safeSingleSec,
        impossible: true,
      }
    }

    const halfRangeSec = minimumRangeSec / 2
    let minSec = safeSingleSec - halfRangeSec
    let maxSec = safeSingleSec + halfRangeSec
    if (minSec < TIME_DOMAIN_MIN_SEC) {
      maxSec += TIME_DOMAIN_MIN_SEC - minSec
      minSec = TIME_DOMAIN_MIN_SEC
    }
    if (maxSec > TIME_DOMAIN_MAX_SEC) {
      minSec -= maxSec - TIME_DOMAIN_MAX_SEC
      maxSec = TIME_DOMAIN_MAX_SEC
    }
    minSec = clampCursorSeconds(minSec)
    maxSec = clampCursorSeconds(maxSec)
    return {
      minSec,
      maxSec,
      impossible: false,
    }
  }

  const resolveTimelineIndexForAbsoluteSec = (seconds: number): number => {
    const capacity = frequencyHistoryRing.capacity
    if (capacity <= 1) {
      return 0
    }
    const safeSec = clampCursorSeconds(seconds)
    const ratio = safeSec / SPECTROGRAM_WINDOW_SECONDS
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
      const timelineIndex = resolveTimelineIndexForAbsoluteSec(fftCursorState.singleSec)
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
    const impossibleRange = minimumRangeSec > SPECTROGRAM_WINDOW_SECONDS
    const useFallback = impossibleRange || widthSec < minimumRangeSec

    if (useFallback) {
      showFallbackNoticeIfNeeded(minimumRangeSec, impossibleRange ? 'impossible' : 'short-range', allowFallbackNotice)
    } else {
      fftCursorState.lastFallbackNoticeKey = null
    }

    if (widthSec <= 0) {
      const centerSec = clampCursorSeconds((minSec + maxSec) / 2)
      const timelineIndex = resolveTimelineIndexForAbsoluteSec(centerSec)
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
      SPECTROGRAM_WINDOW_SECONDS,
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

  const renderFftPanel = (state: AppState): void => {
    const metrics = resizeFftCanvas()
    const { plotX, plotY, plotWidth, plotHeight, canvasWidth, canvasHeight } = metrics
    const minDb = state.decibelMin
    const maxDb = state.decibelMax
    const nyquistHz = Math.max(1, timelineSyncState.sampleRateHz / 2)
    const freqMinHz = clamp(state.frequencyMinHz, FFT_PANEL_DOMAIN_MIN_HZ, nyquistHz)
    const freqMaxHz = clamp(state.frequencyMaxHz, freqMinHz + MIN_RANGE_GAP_HZ, nyquistHz)
    const freqSpan = Math.max(MIN_RANGE_GAP_HZ, freqMaxHz - freqMinHz)
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
    fftCanvasCtx.strokeStyle = 'rgb(108 214 255)'
    fftCanvasCtx.lineWidth = 1.4
    fftCanvasCtx.lineJoin = 'round'
    fftCanvasCtx.lineCap = 'round'

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

    fftCanvasCtx.beginPath()
    let smoothedDb = sampleSpectrumDb(freqMinHz)
    for (let x = 0; x < plotWidth; x += 1) {
      const ratio = x / Math.max(plotWidth - 1, 1)
      const freqHz = freqMinHz + ratio * freqSpan
      const rawDb = sampleSpectrumDb(freqHz)
      smoothedDb += (rawDb - smoothedDb) * FFT_RENDER_SMOOTH_ALPHA
      const yRatio = clamp((maxDb - smoothedDb) / dbSpan, 0, 1)
      const y = plotY + yRatio * plotHeight
      const canvasX = plotX + x
      if (x === 0) {
        fftCanvasCtx.moveTo(canvasX, y)
      } else {
        fftCanvasCtx.lineTo(canvasX, y)
      }
    }
    fftCanvasCtx.stroke()
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

  const updateRouteVisibility = (route: AppRoute): void => {
    elements.loginPage.hidden = route !== 'login'
    elements.appPage.hidden = route !== 'recording'
  }

  const navigateToRoute = (route: AppRoute, mode: HistoryMode): void => {
    const targetPath = routeToPath(route)
    if (window.location.pathname !== targetPath) {
      if (mode === 'push') {
        window.history.pushState({}, '', targetPath)
      } else {
        window.history.replaceState({}, '', targetPath)
      }
    }
    updateRouteVisibility(route)
  }

  const syncRouteByState = (state: AppState): void => {
    if (state.authStatus === 'loading') {
      updateRouteVisibility('login')
      lastAuthStatus = state.authStatus
      return
    }

    const desiredRoute: AppRoute = state.authStatus === 'signed-in' ? 'recording' : 'login'
    const mode: HistoryMode =
      state.authStatus === 'signed-in' && lastAuthStatus === 'signed-out' ? 'push' : 'replace'

    navigateToRoute(desiredRoute, mode)
    lastAuthStatus = state.authStatus
  }

  const getHistoryCapacity = (): number => {
    const directWidth = renderer.getPlotMetrics().plotWidth
    const fallbackWidth = Math.max(1, Math.floor(elements.canvas.clientWidth))
    if (directWidth <= 1) {
      return fallbackWidth
    }
    return Math.max(directWidth, fallbackWidth)
  }

  const syncTimelineState = (): void => {
    const sampleRateHz = Math.max(1, analysisService.getSampleRateHz())
    const plotWidth = Math.max(1, getHistoryCapacity())
    timelineSyncState = {
      sampleRateHz,
      windowSamples: Math.max(1, Math.round(sampleRateHz * SPECTROGRAM_WINDOW_SECONDS)),
      plotWidth,
      capturedSamples: latestCapturedSamples48k,
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
    const previousCapacity = frequencyHistoryRing.capacity
    const nextCapacity = getHistoryCapacity()
    const capacityChanged = previousCapacity > 0 && previousCapacity !== nextCapacity
    if (frequencyHistoryRing.bins > 0) {
      ensureHistoryRingLayout(nextCapacity, frequencyHistoryRing.bins)
    }
    syncTimelineState()
    analysisService.setPlotWidth(nextCapacity)

    if (capacityChanged && stateStore.getState().isRecording) {
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
      SPECTROGRAM_WINDOW_SECONDS,
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
    if (historyResyncInFlight) {
      return
    }
    historyResyncInFlight = true

    try {
      const snapshot = await analysisService.requestHistorySnapshot()
      latestPcmWindow48k = snapshot.pcmWindow48k
      latestCapturedSamples48k = snapshot.capturedSamples48k
      timelineSyncState.capturedSamples = snapshot.capturedSamples48k
      timelineSyncState.sampleRateHz = snapshot.sampleRateHz
      timelineSyncState.windowSamples = Math.max(1, Math.round(snapshot.sampleRateHz * SPECTROGRAM_WINDOW_SECONDS))
      setHistoryFromLinear(snapshot.spectrogramHistory, snapshot.count, snapshot.bins)
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
    const isSignedIn = state.authStatus === 'signed-in'
    const isLocked = !isSignedIn || (conservativeMode && state.isRecording)
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
    const isSignedIn = state.authStatus === 'signed-in'
    const isLocked = !isSignedIn || (conservativeMode && state.isRecording)
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
    const isSignedIn = state.authStatus === 'signed-in'
    const lockTimeRange = !isSignedIn || state.isPlayingBack || state.isRecording || conservativeMode
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
    if (conservativeMode && state.isRecording) {
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
    if (conservativeMode && state.isRecording) {
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
    if (state.isRecording || state.isPlayingBack || conservativeMode) {
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
    const projectedHistory = sampleHistoryByTimeWindow(
      state.frequencyMinHz,
      state.frequencyMaxHz,
      state.timeMinSec,
      state.timeMaxSec,
      frequencyHistoryRing.capacity,
      nyquistHz,
    )
    renderer.redrawHistory(
      projectedHistory.history,
      projectedHistory.count,
      projectedHistory.bins,
      state.decibelMin,
      state.decibelMax,
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
    const isSignedIn = state.authStatus === 'signed-in'
    const canTogglePlayback = isSignedIn && !state.isRecording && !state.isSavingAudio && hasSavableAudio
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
  void syncHistoryFromWorker()
  scheduleFftProfileRefresh(true, false)

  const resolveDisplayedAudioSlice = (state: AppState): DisplayedAudioSlice | null => {
    if (latestPcmWindow48k.length <= 0 || latestCapturedSamples48k <= 0) {
      return null
    }

    const slotCount = Math.max(1, timelineSyncState.plotWidth || frequencyHistoryRing.capacity || getHistoryCapacity())
    const { startSlot, endSlotExclusive } = resolveTimeRangeSlots(
      state.timeMinSec,
      state.timeMaxSec,
      SPECTROGRAM_WINDOW_SECONDS,
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
    const samples = latestPcmWindow48k.subarray(startSample, endSample)
    if (samples.length <= 0) {
      return null
    }

    return {
      samples,
      sampleRateHz: timelineSyncState.sampleRateHz,
      startSample,
      endSample,
    }
  }

  const hasSavableAudioData = (): boolean => {
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
    if (state.isRecording || state.isPlayingBack || state.isSavingAudio) {
      return
    }

    const displayedSlice = resolveDisplayedAudioSlice(state)
    if (!displayedSlice) {
      stateStore.setState({ errorMessage: '再生可能な録音データがありません。' })
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
    if (state.isRecording || state.isPlayingBack || state.isSavingAudio) {
      return
    }

    const displayedSlice = resolveDisplayedAudioSlice(state)
    if (!displayedSlice) {
      stateStore.setState({ errorMessage: '保存可能な録音データがありません。' })
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

  const applySnapshot = (snapshot: AnalysisSnapshot): void => {
    latestPcmWindow48k = snapshot.pcmWindow48k
    latestCapturedSamples48k = snapshot.capturedSamples48k
    timelineSyncState.sampleRateHz = snapshot.sampleRateHz
    timelineSyncState.windowSamples = Math.max(1, Math.round(snapshot.sampleRateHz * SPECTROGRAM_WINDOW_SECONDS))
    timelineSyncState.capturedSamples = snapshot.capturedSamples48k
    setHistoryFromLinear(snapshot.spectrogramHistory, snapshot.count, snapshot.bins)
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
    latestPcmWindow48k = new Float32Array(0)
    latestCapturedSamples48k = 0
    timelineSyncState.capturedSamples = 0
    resetFrequencyHistory()
    resetAnalysisBuffers()
    renderer.clear()
    fftProfileState = null
    fftCursorState.lastFallbackNoticeKey = null
    stateStore.setState({ errorMessage: null })
    scheduleFftProfileRefresh(true, false)
  }

  const applyQualityProfile = (_reconfigureAnalysis: boolean, redrawHistory: boolean): void => {
    const qualityProfile = getActiveQualityProfile()
    elements.canvas.dataset.dprCap = String(qualityProfile.dprCap)
    applyRendererLayout()
    scheduleFftProfileRefresh(true, false)

    if (redrawHistory) {
      requestHistoryRender()
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
    renderer.drawColumn(projectedFrequencyData, state.decibelMin, state.decibelMax)
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

  const firebaseConfig = getFirebaseConfig()
  const authService = (() => {
    if (!firebaseConfig.config) {
      stateStore.setState({
        authStatus: 'signed-out',
        errorMessage: `Firebase設定が不足しています: ${firebaseConfig.missingKeys.join(', ')}`,
      })
      return createAuthService(null)
    }

    try {
      const { auth } = initFirebase(firebaseConfig.config)
      return createAuthService(auth)
    } catch (error) {
      stateStore.setState({
        authStatus: 'signed-out',
        errorMessage: toErrorMessage(error, 'Firebase初期化に失敗しました。'),
      })
      return createAuthService(null)
    }
  })()

  const render = (state: AppState): void => {
    syncRouteByState(state)
    if (!elements.appPage.hidden && renderer.getPlotMetrics().plotWidth <= 1) {
      applyQualityProfile(false, false)
    }

    const hasSavableAudio = hasSavableAudioData()
    renderAuthView(elements, state, authService.isEnabled)
    renderControlsView(elements, state, hasSavableAudio)
    renderPlaybackWidget(state, hasSavableAudio)
    elements.analysisMetrics.textContent = formatAnalysisMetricsText(
      Math.max(1, timelineSyncState.sampleRateHz),
      state.analysisFrameSize,
    )
    renderAnalysisControls(state)
    renderFrequencyControls(state)
    renderDecibelControls(state)
    renderTimeControls(state)
    renderDecibelTicks(state.decibelMin, state.decibelMax)
    updateAxisConfig(state)
    elements.fftAverageToggleButton.disabled = state.authStatus !== 'signed-in'
    elements.fftAverageToggleButton.classList.toggle('is-active', fftCursorState.mode === 'average')

    const frequencyRangeChanged =
      lastRenderedRangeMinHz !== state.frequencyMinHz || lastRenderedRangeMaxHz !== state.frequencyMaxHz
    const decibelRangeChanged =
      lastRenderedDecibelMin !== state.decibelMin || lastRenderedDecibelMax !== state.decibelMax
    const timeRangeChanged = lastRenderedTimeMinSec !== state.timeMinSec || lastRenderedTimeMaxSec !== state.timeMaxSec
    const analysisConfigChanged =
      lastRenderedFrameSize !== state.analysisFrameSize ||
      lastRenderedOverlapPercent !== state.analysisOverlapPercent ||
      lastRenderedUpperFrequencyHz !== state.analysisUpperFrequencyHz
    if (frequencyRangeChanged || decibelRangeChanged || timeRangeChanged) {
      requestHistoryRender()
      lastRenderedRangeMinHz = state.frequencyMinHz
      lastRenderedRangeMaxHz = state.frequencyMaxHz
      lastRenderedDecibelMin = state.decibelMin
      lastRenderedDecibelMax = state.decibelMax
      lastRenderedTimeMinSec = state.timeMinSec
      lastRenderedTimeMaxSec = state.timeMaxSec
    }
    if (analysisConfigChanged) {
      lastRenderedFrameSize = state.analysisFrameSize
      lastRenderedOverlapPercent = state.analysisOverlapPercent
      lastRenderedUpperFrequencyHz = state.analysisUpperFrequencyHz
      scheduleFftProfileRefresh(true, false)
    }

    updateCursorOverlay(state)
    renderFftPanel(state)

    const isRecordingRouteVisible = !elements.appPage.hidden
    if (state.errorMessage && isRecordingRouteVisible) {
      elements.errorMessage.hidden = false
      elements.errorMessage.textContent = state.errorMessage
    } else {
      elements.errorMessage.hidden = true
      elements.errorMessage.textContent = ''
    }
  }

  stateStore.subscribe(render)

  if (authService.isEnabled) {
    authUnsubscribe = authService.subscribeAuthState((user) => {
      stateStore.setState({
        authStatus: user ? 'signed-in' : 'signed-out',
        userName: user?.displayName ?? user?.email ?? null,
        isSavingAudio: user ? stateStore.getState().isSavingAudio : false,
      })

      if (!user) {
        void (async () => {
          await stopVisualization()
          await stopPlayback()
        })()
      }
    })
  }

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
    if (state.authStatus !== 'signed-in' || (conservativeMode && state.isRecording)) {
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
    if (state.authStatus !== 'signed-in' || (conservativeMode && state.isRecording)) {
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
    if (state.authStatus !== 'signed-in' || state.isPlayingBack || state.isRecording || conservativeMode) {
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
    if (state.isPlayingBack || state.isRecording || conservativeMode) {
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
    if (enable) {
      const minimumRangeSec = getMinimumCursorRangeSec(state)
      const range = ensureAverageCursorRange(fftCursorState.singleSec, minimumRangeSec)
      fftCursorState.mode = 'average'
      fftCursorState.rangeMinSec = range.minSec
      fftCursorState.rangeMaxSec = range.maxSec
      if (range.impossible) {
        showFallbackNoticeIfNeeded(minimumRangeSec, 'impossible', true)
      }
      scheduleFftProfileRefresh(true, true)
      return
    }

    const midpointSec = clampCursorSeconds((fftCursorState.rangeMinSec + fftCursorState.rangeMaxSec) / 2)
    fftCursorState.mode = 'single'
    fftCursorState.singleSec = midpointSec
    fftCursorState.lastFallbackNoticeKey = null
    scheduleFftProfileRefresh(true, false)
  }

  const resolveVisibleCursorPositions = (
    state: AppState,
    metrics: PlotMetrics,
  ): Array<{ handle: FftCursorDragHandle; xPx: number }> => {
    const visibleSpanSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    const visibleMinSec = state.timeMinSec
    const visibleMaxSec = state.timeMaxSec
    const output: Array<{ handle: FftCursorDragHandle; xPx: number }> = []
    const appendVisiblePosition = (seconds: number, handle: FftCursorDragHandle): void => {
      if (seconds < visibleMinSec || seconds > visibleMaxSec) {
        return
      }
      const ratio = clamp((seconds - visibleMinSec) / visibleSpanSec, 0, 1)
      output.push({
        handle,
        xPx: metrics.plotX + ratio * metrics.plotWidth,
      })
    }

    if (fftCursorState.mode === 'single') {
      appendVisiblePosition(fftCursorState.singleSec, 'single')
      return output
    }

    appendVisiblePosition(fftCursorState.rangeMinSec, 'min')
    appendVisiblePosition(fftCursorState.rangeMaxSec, 'max')
    return output
  }

  const beginFftCursorDrag = (event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.authStatus !== 'signed-in') {
      return
    }

    const metrics = renderer.getPlotMetrics()
    if (metrics.plotWidth <= 0 || metrics.plotHeight <= 0) {
      return
    }

    const rect = elements.canvas.getBoundingClientRect()
    const pointerX = (event.clientX - rect.left) * Math.max(1, metrics.dpr)
    const visiblePositions = resolveVisibleCursorPositions(state, metrics)
    if (visiblePositions.length <= 0) {
      return
    }

    const hitRadiusPx = CURSOR_HIT_TEST_PX * Math.max(1, metrics.dpr)
    let selected: { handle: FftCursorDragHandle; xPx: number } | null = null
    let minDistance = Number.POSITIVE_INFINITY
    for (const candidate of visiblePositions) {
      const distance = Math.abs(pointerX - candidate.xPx)
      if (distance > hitRadiusPx) {
        continue
      }
      if (distance < minDistance) {
        selected = candidate
        minDistance = distance
      }
    }

    if (!selected) {
      return
    }

    fftCursorState.activeDragHandle = selected.handle
    fftCursorState.activePointerId = event.pointerId
    elements.canvas.setPointerCapture(event.pointerId)
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

    const pointerX = (event.clientX - rect.left) * Math.max(1, metrics.dpr)
    const ratio = clamp((pointerX - metrics.plotX) / metrics.plotWidth, 0, 1)
    const visibleSpanSec = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    const nextSec = clampCursorSeconds(state.timeMinSec + ratio * visibleSpanSec)

    if (fftCursorState.mode === 'single' || fftCursorState.activeDragHandle === 'single') {
      fftCursorState.singleSec = nextSec
      scheduleFftProfileRefresh(false, false)
      updateCursorOverlay(state)
      return
    }

    if (fftCursorState.activeDragHandle === 'min') {
      fftCursorState.rangeMinSec = Math.min(nextSec, fftCursorState.rangeMaxSec)
    } else {
      fftCursorState.rangeMaxSec = Math.max(nextSec, fftCursorState.rangeMinSec)
    }

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

  elements.fftAverageToggleButton.addEventListener('click', () => {
    const state = stateStore.getState()
    if (state.authStatus !== 'signed-in') {
      return
    }
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

  elements.startButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    const state = stateStore.getState()
    if (state.authStatus !== 'signed-in') {
      stateStore.setState({
        errorMessage: '先にGoogleログインしてください。',
      })
      return
    }

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

    try {
      await stopPlayback()
      const currentPlotWidth = Math.max(1, getHistoryCapacity())
      analysisService.start({
        frameSize: state.analysisFrameSize,
        overlapPercent: state.analysisOverlapPercent,
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
        fftSize: state.analysisFrameSize,
        upperFrequencyHz: state.analysisUpperFrequencyHz,
      })
      conservativeMode = false
      resetAnalysisBuffers()
      lastAnimationTimestamp = null
      activeQualityStageIndex = 0
      applyQualityProfile(false, false)

      const nyquistFrequencyHz = analysisService.getSampleRateHz() / 2
      const detectedMaxFrequencyHz = Math.min(nyquistFrequencyHz, state.analysisUpperFrequencyHz)
      setFrequencyDomainMax(detectedMaxFrequencyHz)

      stateStore.setState({
        isRecording: true,
        hasMicPermission: true,
        audioReady: true,
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
    if (state.authStatus !== 'signed-in') {
      stateStore.setState({ errorMessage: '先にGoogleログインしてください。' })
      return
    }

    if (state.isSavingAudio || state.isPlayingBack || state.isRecording) {
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
    if (state.authStatus !== 'signed-in') {
      stateStore.setState({ errorMessage: '先にGoogleログインしてください。' })
      return
    }

    if (state.isSavingAudio) {
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
    if (state.authStatus !== 'signed-in') {
      stateStore.setState({ errorMessage: '先にGoogleログインしてください。' })
      return
    }

    if (state.isRecording || state.isPlayingBack) {
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

  elements.loginButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    if (!authService.isEnabled) {
      stateStore.setState({ errorMessage: 'Firebase認証が未設定です。' })
      return
    }

    try {
      await authService.signInWithGoogle()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, 'Googleログインに失敗しました。'),
      })
    }
  })

  elements.logoutButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    try {
      await stopVisualization()
      await stopPlayback()
      await authService.signOut()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, 'ログアウトに失敗しました。'),
      })
    }
  })

  window.addEventListener('popstate', () => {
    const state = stateStore.getState()
    const desiredRoute: AppRoute = state.authStatus === 'signed-in' ? 'recording' : 'login'
    if (routeFromPath(window.location.pathname) !== desiredRoute) {
      navigateToRoute(desiredRoute, 'replace')
    }
  })

  window.addEventListener('beforeunload', () => {
    if (authUnsubscribe) {
      authUnsubscribe()
    }
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

    void stopVisualization()
    void stopPlayback()
    analysisService.dispose()
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
