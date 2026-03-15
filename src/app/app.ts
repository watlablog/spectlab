import { createAudioEngine } from '../audio/audioEngine'
import { createAppStateStore } from './state'
import { getFirebaseConfig } from '../firebase/config'
import { createAuthService } from '../firebase/auth'
import { initFirebase } from '../firebase/init'
import { createRenderer } from '../render/canvas'
import { renderAuthView } from '../ui/authView'
import { renderControlsView } from '../ui/controlsView'
import { getUIElements } from '../ui/dom'
import { isMicrophonePermissionError, toErrorMessage } from '../utils/errors'
import type { AppState, AuthStatus } from './types'

const SPECTROGRAM_WINDOW_SECONDS = 10
const FREQUENCY_DOMAIN_MIN_HZ = 0
const DEFAULT_MAX_FREQUENCY_HZ = 22050
const FREQUENCY_TICK_COUNT = 6
const TIME_TICKS_SECONDS = [0, 2, 4, 6, 8, 10]
const LOGIN_PATH = '/login'
const RECORDING_PATH = '/recording'
const FREQUENCY_STEP_HZ = 1
const MIN_RANGE_GAP_HZ = 1
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

type AppRoute = 'login' | 'recording'
type HistoryMode = 'push' | 'replace'
type DragHandle = 'min' | 'max'

interface FrequencyRange {
  minHz: number
  maxHz: number
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

function roundToFrequencyStep(value: number): number {
  return Math.round(value / FREQUENCY_STEP_HZ) * FREQUENCY_STEP_HZ
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

export function bootstrapApp(): void {
  const elements = getUIElements()
  const stateStore = createAppStateStore({
    frequencyDomainMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyDomainMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
    frequencyMinHz: FREQUENCY_DOMAIN_MIN_HZ,
    frequencyMaxHz: DEFAULT_MAX_FREQUENCY_HZ,
  })
  const audioEngine = createAudioEngine()
  const renderer = createRenderer()
  renderer.init(elements.canvas)

  let authUnsubscribe: (() => void) | null = null
  let frameId: number | null = null
  let lastAnimationTimestamp: number | null = null
  let accumulatedSeconds = 0
  let lastAuthStatus: AuthStatus | null = null
  let dragHandle: DragHandle | null = null
  let dragPointerId: number | null = null
  let projectionBuffer = new Float32Array(0)
  let frequencyHistoryColumns: Float32Array<ArrayBuffer>[] = []
  let lastRenderedRangeMinHz: number | null = null
  let lastRenderedRangeMaxHz: number | null = null

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

  const cloneFrequencyData = (source: Float32Array): Float32Array<ArrayBuffer> => {
    const cloned = new Float32Array(source.length)
    cloned.set(source)
    return cloned
  }

  const getHistoryCapacity = (): number => {
    const directWidth = elements.canvas.width
    if (directWidth > 0) {
      return directWidth
    }

    const fallbackWidth = Math.floor(elements.canvas.clientWidth * (window.devicePixelRatio || 1))
    return Math.max(1, fallbackWidth)
  }

  const trimHistoryToCapacity = (capacity: number): void => {
    if (frequencyHistoryColumns.length <= capacity) {
      return
    }

    frequencyHistoryColumns = frequencyHistoryColumns.slice(frequencyHistoryColumns.length - capacity)
  }

  const appendHistoryColumn = (rawFrequencyData: Float32Array): void => {
    const capacity = getHistoryCapacity()
    trimHistoryToCapacity(capacity)
    frequencyHistoryColumns.push(cloneFrequencyData(rawFrequencyData))
    trimHistoryToCapacity(capacity)
  }

  const resetFrequencyHistory = (): void => {
    frequencyHistoryColumns = []
  }

  const renderTimeTicks = (): void => {
    const fragment = document.createDocumentFragment()

    TIME_TICKS_SECONDS.forEach((tickSec, index) => {
      const tick = document.createElement('div')
      tick.className = 'x-tick'
      tick.style.left = `${(tickSec / SPECTROGRAM_WINDOW_SECONDS) * 100}%`

      if (index === 0) {
        tick.classList.add('is-edge-start')
      } else if (index === TIME_TICKS_SECONDS.length - 1) {
        tick.classList.add('is-edge-end')
      }

      const mark = document.createElement('span')
      mark.className = 'x-tick-mark'

      const label = document.createElement('span')
      label.className = 'x-tick-label'
      label.textContent = String(tickSec)

      tick.append(mark, label)
      fragment.append(tick)
    })

    elements.xTicks.replaceChildren(fragment)
  }

  const renderFrequencyTicks = (rangeMinHz: number, rangeMaxHz: number): void => {
    const fragment = document.createDocumentFragment()
    const spanHz = Math.max(MIN_RANGE_GAP_HZ, rangeMaxHz - rangeMinHz)

    for (let index = 0; index < FREQUENCY_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(FREQUENCY_TICK_COUNT - 1, 1)
      const valueHz = rangeMaxHz - ratio * spanHz
      const roundedValueHz = Math.max(0, Math.round(valueHz))

      const tick = document.createElement('div')
      tick.className = 'y-tick'

      const label = document.createElement('span')
      label.className = 'y-tick-label'
      label.textContent = NUMBER_FORMATTER.format(roundedValueHz)

      tick.append(label)
      fragment.append(tick)
    }

    elements.yTicks.replaceChildren(fragment)
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

  const restoreFrequencyInputs = (): void => {
    const state = stateStore.getState()
    elements.freqMinInput.value = String(state.frequencyMinHz)
    elements.freqMaxInput.value = String(state.frequencyMaxHz)
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
    renderer.clear()

    const state = stateStore.getState()
    const capacity = getHistoryCapacity()
    trimHistoryToCapacity(capacity)

    if (frequencyHistoryColumns.length === 0) {
      return
    }

    const nyquistHz = audioEngine.getMaxFrequencyHz() ?? state.frequencyDomainMaxHz
    for (const rawColumn of frequencyHistoryColumns) {
      const projectedFrequencyData = projectFrequencyRange(
        rawColumn,
        state.frequencyMinHz,
        state.frequencyMaxHz,
        nyquistHz,
      )
      renderer.drawColumn(projectedFrequencyData)
    }
  }

  renderTimeTicks()
  renderFrequencyTicks(FREQUENCY_DOMAIN_MIN_HZ, DEFAULT_MAX_FREQUENCY_HZ)

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
    accumulatedSeconds = 0
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

    const deltaSeconds = Math.max(0, (timestamp - lastAnimationTimestamp) / 1000)
    lastAnimationTimestamp = timestamp
    accumulatedSeconds += deltaSeconds

    const plotWidth = Math.max(elements.canvas.width, 1)
    const secondsPerColumn = SPECTROGRAM_WINDOW_SECONDS / plotWidth

    let columnsDrawn = 0
    while (accumulatedSeconds >= secondsPerColumn && columnsDrawn < 120) {
      const rawFrequencyData = audioEngine.getFrequencyData()
      appendHistoryColumn(rawFrequencyData)
      const nyquistHz = audioEngine.getMaxFrequencyHz() ?? state.frequencyDomainMaxHz
      const projectedFrequencyData = projectFrequencyRange(
        rawFrequencyData,
        state.frequencyMinHz,
        state.frequencyMaxHz,
        nyquistHz,
      )
      renderer.drawColumn(projectedFrequencyData)
      accumulatedSeconds -= secondsPerColumn
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
    renderAuthView(elements, state, authService.isEnabled)
    renderControlsView(elements, state)
    renderFrequencyTicks(state.frequencyMinHz, state.frequencyMaxHz)
    renderFrequencyControls(state)

    const frequencyRangeChanged =
      lastRenderedRangeMinHz !== state.frequencyMinHz || lastRenderedRangeMaxHz !== state.frequencyMaxHz
    if (frequencyRangeChanged) {
      renderHistoryFromBuffer()
      lastRenderedRangeMinHz = state.frequencyMinHz
      lastRenderedRangeMaxHz = state.frequencyMaxHz
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
      })

      if (!user) {
        void stopVisualization()
      }
    })
  }

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

  const beginSliderDrag = (target: DragHandle, event: PointerEvent): void => {
    const state = stateStore.getState()
    if (state.authStatus !== 'signed-in') {
      return
    }

    dragHandle = target
    dragPointerId = event.pointerId
    elements.freqSlider.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    applySliderClientY(event.clientY, target)
  }

  const endSliderDrag = (event: PointerEvent): void => {
    if (dragPointerId !== event.pointerId) {
      return
    }

    dragHandle = null
    dragPointerId = null
    if (elements.freqSlider.hasPointerCapture(event.pointerId)) {
      elements.freqSlider.releasePointerCapture(event.pointerId)
    }
  }

  elements.freqHandleMin.addEventListener('pointerdown', (event) => {
    beginSliderDrag('min', event)
  })

  elements.freqHandleMax.addEventListener('pointerdown', (event) => {
    beginSliderDrag('max', event)
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
    beginSliderDrag(distanceToMax <= distanceToMin ? 'max' : 'min', event)
  })

  elements.freqSlider.addEventListener('pointermove', (event) => {
    if (!dragHandle || dragPointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    applySliderClientY(event.clientY, dragHandle)
  })

  elements.freqSlider.addEventListener('pointerup', endSliderDrag)
  elements.freqSlider.addEventListener('pointercancel', endSliderDrag)

  elements.startButton.addEventListener('click', async () => {
    stateStore.setState({ errorMessage: null })

    if (stateStore.getState().authStatus !== 'signed-in') {
      stateStore.setState({
        errorMessage: '先にGoogleログインしてください。',
      })
      return
    }

    try {
      await audioEngine.start()
      renderer.clear()
      resetFrequencyHistory()
      lastAnimationTimestamp = null
      accumulatedSeconds = 0

      const detectedMaxFrequencyHz =
        audioEngine.getMaxFrequencyHz() ?? stateStore.getState().frequencyDomainMaxHz
      setFrequencyDomainMax(detectedMaxFrequencyHz)

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

  elements.stopButton.addEventListener('click', async () => {
    await stopVisualization()
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

    void stopVisualization()
  })

  let resizeRafId: number | null = null
  window.addEventListener('resize', () => {
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId)
    }

    resizeRafId = requestAnimationFrame(() => {
      renderHistoryFromBuffer()
      resizeRafId = null
    })
  })
}
