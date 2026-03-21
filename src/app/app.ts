import { createAudioEngine } from '../audio/audioEngine'
import { createStftTransformer, type StftTransformer } from '../audio/stft'
import { createAppStateStore } from './state'
import { getFirebaseConfig } from '../firebase/config'
import { createAuthService } from '../firebase/auth'
import { initFirebase } from '../firebase/init'
import { createRenderer, type AxisRenderConfig } from '../render/canvas'
import { renderAuthView } from '../ui/authView'
import { renderControlsView } from '../ui/controlsView'
import { getUIElements } from '../ui/dom'
import { isMicrophonePermissionError, toErrorMessage } from '../utils/errors'
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
const DECIBEL_INPUT_MIN = -40
const DECIBEL_INPUT_MAX = 140
const DECIBEL_STEP = 1
const MIN_DECIBEL_GAP = 1
const DECIBEL_TICK_COUNT = 6
const SILENCE_DECIBELS = -160
const MOBILE_BREAKPOINT_PX = 760
const MAX_ANALYSIS_BACKLOG_HOPS = 24
const MAX_COLUMN_BACKLOG_FACTOR = 4
const MAX_PENDING_ANALYSIS_COLUMNS = 256
const STAGE_DEGRADE_LEVEL1_FRAME_MS = 24
const STAGE_DEGRADE_LEVEL2_FRAME_MS = 32
const STAGE_DEGRADE_REQUIRED_FRAMES = 120
const STAGE_UPGRADE_FRAME_MS = 18
const STAGE_UPGRADE_REQUIRED_FRAMES = 300

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
  samplesPerColumn: number
  columnCursorSample: number
}

interface DisplayedAudioSlice {
  samples: Float32Array
  sampleRateHz: number
  startSample: number
  endSample: number
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
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  if (parsed < MIN_OVERLAP_PERCENT || parsed > MAX_OVERLAP_PERCENT) {
    return null
  }

  return normalizeOverlapPercent(parsed)
}

function parseDecibelInput(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return roundToDecibelStep(parsed)
}

function parseFrequencyInput(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return roundToFrequencyStep(parsed)
}

function parseTimeInput(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.round(parsed / TIME_STEP_SEC) * TIME_STEP_SEC
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
  const renderer = createRenderer()
  renderer.init(elements.canvas)

  let authUnsubscribe: (() => void) | null = null
  let frameId: number | null = null
  let lastAnimationTimestamp: number | null = null
  let timelineSyncState: TimelineSyncState = {
    sampleRateHz: 0,
    windowSamples: 0,
    plotWidth: 1,
    samplesPerColumn: 1,
    columnCursorSample: 0,
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
  let analysisAccumulatorSamples = 0
  let activeHopSamples = 1
  let activeSampleRateHz = 0
  let activeQualityStageIndex = 0
  let frameTimeEmaMs = 1000 / DESKTOP_QUALITY_PROFILE.renderFps
  let aboveLevel1FrameCount = 0
  let aboveLevel2FrameCount = 0
  let belowRecoveryFrameCount = 0
  let resizeObserver: ResizeObserver | null = null
  let pendingColumnQueue: Float32Array[] = []
  let lastStableColumnData: Float32Array | null = null
  let silenceColumnData: Float32Array | null = null
  let stftTransformer: StftTransformer | null = null
  let playbackContext: AudioContext | null = null
  let playbackSourceNode: AudioBufferSourceNode | null = null
  const axisConfig: AxisRenderConfig = {
    timeWindowSec: SPECTROGRAM_WINDOW_SECONDS,
    timeLabelOffsetSec: 0,
    frequencyMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
    xTicksSec: [0, 2, 4, 6, 8, 10],
    yTickCount: FREQUENCY_TICK_COUNT,
  }

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
    if (directWidth > 0) {
      return directWidth
    }
    return Math.max(1, Math.floor(elements.canvas.clientWidth))
  }

  const syncTimelineState = (options: { resetCursor: boolean } = { resetCursor: false }): void => {
    const captureMetrics = audioEngine.getCaptureMetrics()
    const plotWidth = Math.max(1, getHistoryCapacity())
    const sampleRateHz = Math.max(0, captureMetrics.sampleRateHz ?? timelineSyncState.sampleRateHz)
    const fallbackWindowSamples =
      sampleRateHz > 0 ? Math.max(1, Math.round(sampleRateHz * SPECTROGRAM_WINDOW_SECONDS)) : plotWidth
    const windowSamples = Math.max(1, captureMetrics.windowSamples || fallbackWindowSamples)
    const samplesPerColumn = Math.max(1 / plotWidth, windowSamples / plotWidth)
    const nextCursorSample = options.resetCursor
      ? captureMetrics.capturedSamplesTotal
      : timelineSyncState.columnCursorSample

    timelineSyncState = {
      sampleRateHz,
      windowSamples,
      plotWidth,
      samplesPerColumn,
      columnCursorSample: nextCursorSample,
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
      const copyCount = Math.min(previousRing.count, capacity)
      const startFrom = previousRing.count - copyCount
      const targetStart = capacity - copyCount

      for (let index = 0; index < copyCount; index += 1) {
        const sourceChronologicalIndex = startFrom + index
        const sourceColumnIndex =
          (previousRing.head - previousRing.count + sourceChronologicalIndex + previousRing.capacity) %
          previousRing.capacity
        const sourceOffset = sourceColumnIndex * bins
        const targetOffset = (targetStart + index) * bins
        nextRing.data.set(previousRing.data.subarray(sourceOffset, sourceOffset + bins), targetOffset)
      }
    }

    frequencyHistoryRing = nextRing
    historyLinearBuffer = new Float32Array(0)
  }

  const ensureHistoryRingMatchesRenderer = (): void => {
    const nextCapacity = getHistoryCapacity()
    if (frequencyHistoryRing.bins > 0) {
      ensureHistoryRingLayout(nextCapacity, frequencyHistoryRing.bins)
    }
    syncTimelineState({ resetCursor: true })
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

  const resetAnalysisBuffers = (): void => {
    analysisAccumulatorSamples = 0
    activeHopSamples = 1
    activeSampleRateHz = 0
    renderGateAccumulatorSeconds = 0
    frameTimeEmaMs = 1000 / DESKTOP_QUALITY_PROFILE.renderFps
    aboveLevel1FrameCount = 0
    aboveLevel2FrameCount = 0
    belowRecoveryFrameCount = 0
    pendingColumnQueue = []
    lastStableColumnData = null
    silenceColumnData = null
    stftTransformer = null
    timelineSyncState.columnCursorSample = audioEngine.getCaptureMetrics().capturedSamplesTotal
  }

  const setLastStableColumn = (source: Float32Array): void => {
    if (!lastStableColumnData || lastStableColumnData.length !== source.length) {
      lastStableColumnData = new Float32Array(source.length)
    }
    lastStableColumnData.set(source)
  }

  const ensureSilenceColumn = (length: number): void => {
    if (length <= 0) {
      return
    }

    if (silenceColumnData && silenceColumnData.length === length) {
      return
    }

    silenceColumnData = new Float32Array(length)
    silenceColumnData.fill(SILENCE_DECIBELS)
  }

  const mergeAnalysisFrame = (frame: Float32Array): void => {
    if (frame.length === 0) {
      return
    }

    ensureSilenceColumn(frame.length)

    const queuedColumn = new Float32Array(frame.length)
    queuedColumn.set(frame)

    if (pendingColumnQueue.length >= MAX_PENDING_ANALYSIS_COLUMNS) {
      pendingColumnQueue.shift()
    }
    pendingColumnQueue.push(queuedColumn)
  }

  const consumeColumnData = (): Float32Array | null => {
    const queuedColumn = pendingColumnQueue.shift()
    if (queuedColumn) {
      setLastStableColumn(queuedColumn)
      return queuedColumn
    }

    if (lastStableColumnData) {
      return lastStableColumnData
    }

    if (silenceColumnData) {
      return silenceColumnData
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
    elements.dbMinInput.disabled = !isSignedIn
    elements.dbMaxInput.disabled = !isSignedIn
    elements.dbHandleMin.disabled = !isSignedIn
    elements.dbHandleMax.disabled = !isSignedIn

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
    elements.freqMinInput.disabled = !isSignedIn
    elements.freqMaxInput.disabled = !isSignedIn
    elements.freqHandleMin.disabled = !isSignedIn
    elements.freqHandleMax.disabled = !isSignedIn

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
    const lockTimeRange = !isSignedIn || state.isPlayingBack
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
      restoreOverlapInput()
      return
    }

    if (parsedPercent === state.analysisOverlapPercent) {
      return
    }

    stateStore.setState({ analysisOverlapPercent: parsedPercent })
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
    const inputEl = target === 'min' ? elements.dbMinInput : elements.dbMaxInput
    const parsedDb = parseDecibelInput(inputEl.value)
    if (parsedDb === null) {
      restoreDecibelInputs()
      return
    }

    if (target === 'min') {
      const isValid = parsedDb >= DECIBEL_INPUT_MIN && parsedDb <= state.decibelMax - MIN_DECIBEL_GAP
      if (!isValid) {
        restoreDecibelInputs()
        return
      }

      setDecibelRange(parsedDb, state.decibelMax)
      return
    }

    const isValid = parsedDb <= DECIBEL_INPUT_MAX && parsedDb >= state.decibelMin + MIN_DECIBEL_GAP
    if (!isValid) {
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
    const inputEl = target === 'min' ? elements.freqMinInput : elements.freqMaxInput
    const parsedHz = parseFrequencyInput(inputEl.value)

    if (parsedHz === null) {
      restoreFrequencyInputs()
      return
    }

    if (target === 'min') {
      const isValid =
        parsedHz >= state.frequencyDomainMinHz && parsedHz <= state.frequencyMaxHz - MIN_RANGE_GAP_HZ
      if (!isValid) {
        restoreFrequencyInputs()
        return
      }

      stateStore.setState({ frequencyMinHz: parsedHz })
      return
    }

    const isValid = parsedHz <= state.frequencyDomainMaxHz && parsedHz >= state.frequencyMinHz + MIN_RANGE_GAP_HZ
    if (!isValid) {
      restoreFrequencyInputs()
      return
    }

    stateStore.setState({ frequencyMaxHz: parsedHz })
  }

  const commitTimeInput = (target: DragHandle): void => {
    const state = stateStore.getState()
    const inputEl = target === 'min' ? elements.timeMinInput : elements.timeMaxInput
    const parsedSec = parseTimeInput(inputEl.value)

    if (parsedSec === null) {
      restoreTimeInputs()
      return
    }

    if (target === 'min') {
      const isValid = parsedSec >= state.timeDomainMinSec && parsedSec <= state.timeMaxSec - MIN_TIME_GAP_SEC
      if (!isValid) {
        restoreTimeInputs()
        return
      }

      setTimeRange(parsedSec, state.timeMaxSec)
      return
    }

    const isValid = parsedSec <= state.timeDomainMaxSec && parsedSec >= state.timeMinSec + MIN_TIME_GAP_SEC
    if (!isValid) {
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

    const nyquistHz = audioEngine.getMaxFrequencyHz() ?? state.frequencyDomainMaxHz
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

  elements.canvas.dataset.dprCap = String(getActiveQualityProfile().dprCap)
  applyRendererLayout()
  updateAxisConfig(stateStore.getState())

  const resolveDisplayedAudioSlice = (state: AppState): DisplayedAudioSlice | null => {
    const windowSnapshot = audioEngine.getWindowPcmSnapshot()
    if (!windowSnapshot || windowSnapshot.samples.length <= 0) {
      return null
    }

    const slotCount = Math.max(1, timelineSyncState.plotWidth || frequencyHistoryRing.capacity || getHistoryCapacity())
    const { startSlot, endSlotExclusive } = resolveTimeRangeSlots(
      state.timeMinSec,
      state.timeMaxSec,
      SPECTROGRAM_WINDOW_SECONDS,
      slotCount,
    )
    const windowSamples = Math.max(1, windowSnapshot.samples.length)
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
    const samples = windowSnapshot.samples.subarray(startSample, endSample)
    if (samples.length <= 0) {
      return null
    }

    return {
      samples,
      sampleRateHz: windowSnapshot.sampleRateHz,
      startSample,
      endSample,
    }
  }

  const hasSavableAudioData = (): boolean => {
    const captureMetrics = audioEngine.getCaptureMetrics()
    return (
      (captureMetrics.sampleRateHz ?? 0) > 0 &&
      captureMetrics.windowSamples > 0 &&
      captureMetrics.capturedSamplesTotal > 0
    )
  }

  const stopPlayback = async (): Promise<void> => {
    const activeSource = playbackSourceNode
    const activeContext = playbackContext
    playbackSourceNode = null
    playbackContext = null

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

  const stopVisualization = async (): Promise<void> => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
      frameId = null
    }

    try {
      await audioEngine.stop()
    } catch (error) {
      stateStore.setState({
        errorMessage: toErrorMessage(error, '停止処理に失敗しました。'),
      })
    }

    stateStore.setState({
      isRecording: false,
      audioReady: false,
    })

    lastAnimationTimestamp = null
    resetAnalysisBuffers()
  }

  const configureAnalysisScheduler = (state: AppState): void => {
    const sampleRateHz = audioEngine.getSampleRateHz()
    if (!sampleRateHz || sampleRateHz <= 0) {
      activeSampleRateHz = 0
      activeHopSamples = 1
      analysisAccumulatorSamples = 0
      return
    }

    const qualityProfile = getActiveQualityProfile()
    const requestedHopSamples = Math.max(
      1,
      Math.round(state.analysisFrameSize * (1 - state.analysisOverlapPercent / 100)),
    )
    const performanceGuardHopSamples = Math.max(1, Math.ceil(sampleRateHz / Math.max(1, qualityProfile.analysisHz)))
    activeSampleRateHz = sampleRateHz
    activeHopSamples = Math.max(requestedHopSamples, performanceGuardHopSamples)
    analysisAccumulatorSamples = 0
  }

  const applyQualityProfile = (reconfigureAnalysis: boolean, redrawHistory: boolean): void => {
    const qualityProfile = getActiveQualityProfile()
    elements.canvas.dataset.dprCap = String(qualityProfile.dprCap)
    applyRendererLayout()

    if (reconfigureAnalysis) {
      configureAnalysisScheduler(stateStore.getState())
    }

    if (redrawHistory) {
      renderHistoryFromBuffer()
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

  const analyzeCurrentFrame = (): Float32Array => {
    if (!stftTransformer) {
      return new Float32Array(0)
    }

    const timeDomainData = audioEngine.getTimeDomainData()
    return stftTransformer.transform(timeDomainData)
  }

  const renderProjectedColumn = (state: AppState, rawFrequencyData: Float32Array): void => {
    appendHistoryColumn(rawFrequencyData)

    const fullTimeSpan = Math.max(MIN_TIME_GAP_SEC, state.timeDomainMaxSec - state.timeDomainMinSec)
    const selectedTimeSpan = Math.max(MIN_TIME_GAP_SEC, state.timeMaxSec - state.timeMinSec)
    const usesTimeZoom = selectedTimeSpan < fullTimeSpan - 1e-6
    if (usesTimeZoom) {
      renderHistoryFromBuffer()
      return
    }

    const nyquistHz = audioEngine.getMaxFrequencyHz() ?? state.frequencyDomainMaxHz
    const projectedFrequencyData = projectFrequencyRange(
      rawFrequencyData,
      state.frequencyMinHz,
      state.frequencyMaxHz,
      nyquistHz,
    )
    renderer.drawColumn(projectedFrequencyData, state.decibelMin, state.decibelMax)
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

    analysisAccumulatorSamples += deltaSeconds * activeSampleRateHz
    renderGateAccumulatorSeconds += deltaSeconds

    const qualityProfile = getActiveQualityProfile()
    const maxAnalysisBacklogSamples = activeHopSamples * MAX_ANALYSIS_BACKLOG_HOPS
    if (analysisAccumulatorSamples > maxAnalysisBacklogSamples) {
      analysisAccumulatorSamples = maxAnalysisBacklogSamples
    }

    let analysisSteps = 0
    while (
      analysisAccumulatorSamples >= activeHopSamples &&
      analysisSteps < qualityProfile.maxAnalysisStepsPerFrame
    ) {
      const rawFrequencyData = analyzeCurrentFrame()
      mergeAnalysisFrame(rawFrequencyData)
      analysisAccumulatorSamples -= activeHopSamples
      analysisSteps += 1
    }

    const captureMetrics = audioEngine.getCaptureMetrics()
    if (
      captureMetrics.sampleRateHz &&
      timelineSyncState.sampleRateHz > 0 &&
      Math.abs(captureMetrics.sampleRateHz - timelineSyncState.sampleRateHz) > 1e-6
    ) {
      if (frequencyHistoryRing.bins > 0) {
        frequencyHistoryRing = initializeHistoryWithSilence(
          Math.max(1, getHistoryCapacity()),
          frequencyHistoryRing.bins,
          SILENCE_DECIBELS,
        )
        historyLinearBuffer = new Float32Array(0)
        renderHistoryFromBuffer()
      }
      syncTimelineState({ resetCursor: true })
    }

    const currentPlotWidth = Math.max(1, getHistoryCapacity())
    if (timelineSyncState.plotWidth !== currentPlotWidth || timelineSyncState.windowSamples <= 0) {
      syncTimelineState({ resetCursor: true })
    }

    const samplesPerColumn = Math.max(1 / Math.max(1, timelineSyncState.plotWidth), timelineSyncState.samplesPerColumn)
    const targetColumnsPerSecond = currentPlotWidth / SPECTROGRAM_WINDOW_SECONDS
    const minimumColumnsPerFrame = Math.max(
      1,
      Math.ceil(targetColumnsPerSecond / Math.max(1, qualityProfile.renderFps)),
    )
    const maxColumnsPerFrame = Math.max(qualityProfile.maxColumnsPerFrame, minimumColumnsPerFrame + 1)
    const maxColumnBacklogSamples = Math.max(
      samplesPerColumn * maxColumnsPerFrame * MAX_COLUMN_BACKLOG_FACTOR,
      timelineSyncState.sampleRateHz || activeSampleRateHz || 0,
    )
    const sampleBacklog = captureMetrics.capturedSamplesTotal - timelineSyncState.columnCursorSample
    if (maxColumnBacklogSamples > 0 && sampleBacklog > maxColumnBacklogSamples) {
      timelineSyncState.columnCursorSample = captureMetrics.capturedSamplesTotal - maxColumnBacklogSamples
    }

    const renderIntervalSeconds = 1 / Math.max(1, qualityProfile.renderFps)
    if (renderGateAccumulatorSeconds < renderIntervalSeconds) {
      frameId = requestAnimationFrame(drawFrame)
      return
    }

    renderGateAccumulatorSeconds %= renderIntervalSeconds

    let columnsDrawn = 0
    let columnsDue = Math.floor(
      (captureMetrics.capturedSamplesTotal - timelineSyncState.columnCursorSample) / samplesPerColumn,
    )
    while (columnsDue > 0 && columnsDrawn < maxColumnsPerFrame) {
      const columnData = consumeColumnData()
      if (columnData) {
        renderProjectedColumn(state, columnData)
      }
      timelineSyncState.columnCursorSample += samplesPerColumn
      columnsDrawn += 1
      columnsDue = Math.floor(
        (captureMetrics.capturedSamplesTotal - timelineSyncState.columnCursorSample) / samplesPerColumn,
      )
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

    renderAuthView(elements, state, authService.isEnabled)
    renderControlsView(elements, state, hasSavableAudioData())
    renderAnalysisControls(state)
    renderFrequencyControls(state)
    renderDecibelControls(state)
    renderTimeControls(state)
    renderDecibelTicks(state.decibelMin, state.decibelMax)
    updateAxisConfig(state)

    const frequencyRangeChanged =
      lastRenderedRangeMinHz !== state.frequencyMinHz || lastRenderedRangeMaxHz !== state.frequencyMaxHz
    const decibelRangeChanged =
      lastRenderedDecibelMin !== state.decibelMin || lastRenderedDecibelMax !== state.decibelMax
    const timeRangeChanged = lastRenderedTimeMinSec !== state.timeMinSec || lastRenderedTimeMaxSec !== state.timeMaxSec
    if (frequencyRangeChanged || decibelRangeChanged || timeRangeChanged) {
      renderHistoryFromBuffer()
      lastRenderedRangeMinHz = state.frequencyMinHz
      lastRenderedRangeMaxHz = state.frequencyMaxHz
      lastRenderedDecibelMin = state.decibelMin
      lastRenderedDecibelMax = state.decibelMax
      lastRenderedTimeMinSec = state.timeMinSec
      lastRenderedTimeMaxSec = state.timeMaxSec
    }

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
    if (state.authStatus !== 'signed-in') {
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
    if (state.authStatus !== 'signed-in') {
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
    if (state.authStatus !== 'signed-in' || state.isPlayingBack) {
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
    if (state.isPlayingBack) {
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

  elements.startButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    const state = stateStore.getState()
    if (state.authStatus !== 'signed-in') {
      stateStore.setState({
        errorMessage: '先にGoogleログインしてください。',
      })
      return
    }

    if (state.isSavingAudio) {
      stateStore.setState({ errorMessage: '保存処理中です。完了後に再度開始してください。' })
      return
    }

    try {
      await stopPlayback()
      await audioEngine.start({
        fftSize: state.analysisFrameSize,
        upperFrequencyHz: state.analysisUpperFrequencyHz,
      })
      renderer.clear()
      resetFrequencyHistory()
      resetAnalysisBuffers()
      lastAnimationTimestamp = null
      activeQualityStageIndex = 0
      applyQualityProfile(false, false)

      const nyquistFrequencyHz = audioEngine.getMaxFrequencyHz() ?? stateStore.getState().frequencyDomainMaxHz
      const detectedMaxFrequencyHz = Math.min(nyquistFrequencyHz, state.analysisUpperFrequencyHz)
      setFrequencyDomainMax(detectedMaxFrequencyHz)
      configureAnalysisScheduler(state)
      syncTimelineState({ resetCursor: true })
      stftTransformer = createStftTransformer({ frameSize: state.analysisFrameSize })
      const initialFrame = analyzeCurrentFrame()
      const initialBins =
        initialFrame.length > 0 ? initialFrame.length : stftTransformer.frequencyBinCount
      if (initialBins > 0) {
        ensureHistoryRingLayout(getHistoryCapacity(), initialBins)
        ensureSilenceColumn(initialBins)
        renderHistoryFromBuffer()
      }
      mergeAnalysisFrame(initialFrame)

      stateStore.setState({
        isRecording: true,
        hasMicPermission: true,
        audioReady: true,
      })

      frameId = requestAnimationFrame(drawFrame)
    } catch (error) {
      stateStore.setState({
        errorMessage: isMicrophonePermissionError(error)
          ? 'マイク権限が拒否されました。ブラウザ設定を確認してください。'
          : toErrorMessage(error, 'AudioContextの開始に失敗しました。'),
        isRecording: false,
        hasMicPermission: false,
        audioReady: false,
      })
      await audioEngine.stop().catch(() => undefined)
    }
  })

  elements.playButton.addEventListener('click', async () => {
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

  elements.stopButton.addEventListener('click', async () => {
    const state = stateStore.getState()
    if (state.isRecording) {
      await stopVisualization()
    }
    if (state.isPlayingBack) {
      await stopPlayback()
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

    if (resizeObserver) {
      resizeObserver.disconnect()
    }

    void stopVisualization()
    void stopPlayback()
  })

  let resizeRafId: number | null = null
  const scheduleLayoutRefresh = (): void => {
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId)
    }

    resizeRafId = requestAnimationFrame(() => {
      applyQualityProfile(false, false)
      renderHistoryFromBuffer()
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
      analysisAccumulatorSamples = 0
      renderGateAccumulatorSeconds = 0
      timelineSyncState.columnCursorSample = audioEngine.getCaptureMetrics().capturedSamplesTotal
      return
    }

    scheduleLayoutRefresh()

    if (state.isRecording && frameId === null) {
      lastAnimationTimestamp = null
      frameId = requestAnimationFrame(drawFrame)
    }
  })
}
