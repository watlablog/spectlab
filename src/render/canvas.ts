import { amplitudeToRgb } from './colorMap'

const MOBILE_BREAKPOINT_PX = 760
const DESKTOP_DPR_CAP = 2.0
const MOBILE_DPR_CAP = 1.5
const BACKGROUND_COLOR = 'rgb(2 7 16)'
const AXIS_COLOR = 'rgb(156 189 236)'
const GRID_COLOR = 'rgb(80 110 150 / 26%)'
const LABEL_COLOR = 'rgb(166 189 220)'
const CURSOR_SINGLE_COLOR = 'rgb(255 214 92)'
const CURSOR_MIN_COLOR = 'rgb(255 165 102)'
const CURSOR_MAX_COLOR = 'rgb(128 226 255)'
const TICK_SIZE_PX = 6
const SPECTROGRAM_VERTICAL_SMOOTH_ALPHA = 0.42

const DESKTOP_MARGINS = {
  left: 64,
  right: 10,
  top: 12,
  bottom: 36,
}

const MOBILE_MARGINS = {
  left: 52,
  right: 8,
  top: 10,
  bottom: 32,
}

const DEFAULT_AXIS_CONFIG: AxisRenderConfig = {
  timeWindowSec: 10,
  timeLabelOffsetSec: 0,
  frequencyMinHz: 0,
  frequencyMaxHz: 22050,
  xTicksSec: [0, 2, 4, 6, 8, 10],
  yTickCount: 6,
}

export interface PlotMetrics {
  plotX: number
  plotY: number
  plotWidth: number
  plotHeight: number
  canvasWidth: number
  canvasHeight: number
  dpr: number
}

export interface AxisRenderConfig {
  timeWindowSec: number
  timeLabelOffsetSec: number
  frequencyMinHz: number
  frequencyMaxHz: number
  xTicksSec: number[]
  yTickCount: number
}

export interface CursorOverlayConfig {
  mode: 'single' | 'average'
  singleSec: number
  rangeMinSec: number
  rangeMaxSec: number
}

export interface Renderer {
  init(canvas: HTMLCanvasElement): void
  resizeForContainer(): PlotMetrics
  drawColumn(freq: Float32Array, minDecibels: number, maxDecibels: number): void
  composeAxes(config: AxisRenderConfig): void
  setCursorOverlay(config: CursorOverlayConfig | null): void
  redrawHistory(history: Float32Array, count: number, bins: number, minDecibels: number, maxDecibels: number): void
  getPlotMetrics(): PlotMetrics
  clear(): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function sampleInterpolatedValue(data: Float32Array, position: number, fallback: number): number {
  if (data.length <= 0) {
    return fallback
  }

  const safePosition = clamp(position, 0, Math.max(data.length - 1, 0))
  const lowerIndex = Math.floor(safePosition)
  const upperIndex = Math.min(data.length - 1, lowerIndex + 1)
  const blend = safePosition - lowerIndex
  const lowerValue = data[lowerIndex] ?? fallback
  const upperValue = data[upperIndex] ?? lowerValue
  return lowerValue + (upperValue - lowerValue) * blend
}

function sampleInterpolatedOffsetValue(
  data: Float32Array,
  offset: number,
  length: number,
  position: number,
  fallback: number,
): number {
  if (length <= 0) {
    return fallback
  }

  const safePosition = clamp(position, 0, Math.max(length - 1, 0))
  const lowerIndex = Math.floor(safePosition)
  const upperIndex = Math.min(length - 1, lowerIndex + 1)
  const blend = safePosition - lowerIndex
  const lowerValue = data[offset + lowerIndex] ?? fallback
  const upperValue = data[offset + upperIndex] ?? lowerValue
  return lowerValue + (upperValue - lowerValue) * blend
}

function isMobileViewport(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
  }
  return window.innerWidth <= MOBILE_BREAKPOINT_PX
}

class SpectrogramRenderer implements Renderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private spectrogramCanvas: HTMLCanvasElement = document.createElement('canvas')
  private spectrogramCtx: CanvasRenderingContext2D | null = this.spectrogramCanvas.getContext('2d')
  private axesCanvas: HTMLCanvasElement = document.createElement('canvas')
  private axesCtx: CanvasRenderingContext2D | null = this.axesCanvas.getContext('2d')
  private metrics: PlotMetrics = {
    plotX: 0,
    plotY: 0,
    plotWidth: 1,
    plotHeight: 1,
    canvasWidth: 1,
    canvasHeight: 1,
    dpr: 1,
  }
  private axisConfig: AxisRenderConfig = {
    ...DEFAULT_AXIS_CONFIG,
    xTicksSec: [...DEFAULT_AXIS_CONFIG.xTicksSec],
  }
  private cursorOverlay: CursorOverlayConfig | null = null
  private columnImageData: ImageData | null = null
  private readonly numberFormatter = new Intl.NumberFormat('en-US')

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    if (!this.ctx || !this.spectrogramCtx || !this.axesCtx) {
      throw new Error('Failed to initialize 2D canvas context.')
    }

    this.ctx.imageSmoothingEnabled = false
    this.spectrogramCtx.imageSmoothingEnabled = false
    this.axesCtx.imageSmoothingEnabled = false

    this.resizeForContainer()
    this.clear()
  }

  resizeForContainer(): PlotMetrics {
    if (!this.canvas || !this.ctx || !this.spectrogramCtx || !this.axesCtx) {
      return this.metrics
    }

    const mobile = isMobileViewport()
    const defaultCap = mobile ? MOBILE_DPR_CAP : DESKTOP_DPR_CAP
    const requestedCap = Number(this.canvas.dataset.dprCap ?? '')
    const dprCap = Number.isFinite(requestedCap) && requestedCap > 0 ? requestedCap : defaultCap
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap))

    const displayWidth = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const displayHeight = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    const margins = mobile ? MOBILE_MARGINS : DESKTOP_MARGINS

    const plotWidth = Math.max(1, displayWidth - margins.left - margins.right)
    const plotHeight = Math.max(1, displayHeight - margins.top - margins.bottom)

    const nextMetrics: PlotMetrics = {
      plotX: margins.left,
      plotY: margins.top,
      plotWidth,
      plotHeight,
      canvasWidth: displayWidth,
      canvasHeight: displayHeight,
      dpr,
    }

    const sizeChanged =
      this.metrics.canvasWidth !== nextMetrics.canvasWidth ||
      this.metrics.canvasHeight !== nextMetrics.canvasHeight ||
      this.metrics.plotWidth !== nextMetrics.plotWidth ||
      this.metrics.plotHeight !== nextMetrics.plotHeight ||
      this.metrics.plotX !== nextMetrics.plotX ||
      this.metrics.plotY !== nextMetrics.plotY ||
      this.metrics.dpr !== nextMetrics.dpr

    this.metrics = nextMetrics

    if (!sizeChanged) {
      return this.metrics
    }

    this.canvas.width = nextMetrics.canvasWidth
    this.canvas.height = nextMetrics.canvasHeight
    this.spectrogramCanvas.width = nextMetrics.plotWidth
    this.spectrogramCanvas.height = nextMetrics.plotHeight
    this.axesCanvas.width = nextMetrics.canvasWidth
    this.axesCanvas.height = nextMetrics.canvasHeight

    this.columnImageData = this.spectrogramCtx.createImageData(1, nextMetrics.plotHeight)

    this.spectrogramCtx.fillStyle = BACKGROUND_COLOR
    this.spectrogramCtx.fillRect(0, 0, this.spectrogramCanvas.width, this.spectrogramCanvas.height)

    this.redrawAxesLayer()
    this.renderComposite()

    return this.metrics
  }

  drawColumn(freq: Float32Array, minDecibels: number, maxDecibels: number): void {
    if (!this.ctx || !this.spectrogramCtx || freq.length === 0) {
      return
    }

    this.resizeForContainer()

    const { plotWidth, plotHeight } = this.metrics

    if (plotWidth > 1) {
      this.spectrogramCtx.drawImage(
        this.spectrogramCanvas,
        1,
        0,
        plotWidth - 1,
        plotHeight,
        0,
        0,
        plotWidth - 1,
        plotHeight,
      )
    }

    const imageData = this.ensureColumnImageData(plotHeight)
    const pixels = imageData.data

    let smoothedSample = sampleInterpolatedValue(freq, freq.length - 1, minDecibels)
    for (let y = 0; y < plotHeight; y += 1) {
      const binPosition = ((plotHeight - 1 - y) / Math.max(plotHeight - 1, 1)) * (freq.length - 1)
      const sample = sampleInterpolatedValue(freq, binPosition, minDecibels)
      smoothedSample += (sample - smoothedSample) * SPECTROGRAM_VERTICAL_SMOOTH_ALPHA
      const [red, green, blue] = amplitudeToRgb(smoothedSample, minDecibels, maxDecibels)
      const offset = y * 4
      pixels[offset] = red
      pixels[offset + 1] = green
      pixels[offset + 2] = blue
      pixels[offset + 3] = 255
    }

    this.spectrogramCtx.putImageData(imageData, plotWidth - 1, 0)
    this.renderComposite()
  }

  composeAxes(config: AxisRenderConfig): void {
    this.axisConfig = {
      timeWindowSec: config.timeWindowSec,
      timeLabelOffsetSec: config.timeLabelOffsetSec,
      frequencyMinHz: config.frequencyMinHz,
      frequencyMaxHz: config.frequencyMaxHz,
      xTicksSec: [...config.xTicksSec],
      yTickCount: config.yTickCount,
    }

    this.redrawAxesLayer()
    this.renderComposite()
  }

  setCursorOverlay(config: CursorOverlayConfig | null): void {
    this.cursorOverlay = config
    this.renderComposite()
  }

  redrawHistory(history: Float32Array, count: number, bins: number, minDecibels: number, maxDecibels: number): void {
    if (!this.spectrogramCtx) {
      return
    }

    this.resizeForContainer()

    const { plotWidth, plotHeight } = this.metrics
    this.spectrogramCtx.fillStyle = BACKGROUND_COLOR
    this.spectrogramCtx.fillRect(0, 0, plotWidth, plotHeight)

    if (count <= 0 || bins <= 0 || history.length === 0) {
      this.renderComposite()
      return
    }

    const imageData = this.ensureColumnImageData(plotHeight)
    const pixels = imageData.data

    for (let x = 0; x < plotWidth; x += 1) {
      const sourcePosition = count <= 1 ? 0 : (x / Math.max(plotWidth - 1, 1)) * (count - 1)
      const sourceIndexLow = Math.floor(sourcePosition)
      const sourceIndexHigh = Math.min(count - 1, sourceIndexLow + 1)
      const sourceBlend = sourcePosition - sourceIndexLow
      const historyOffsetLow = sourceIndexLow * bins
      const historyOffsetHigh = sourceIndexHigh * bins

      let smoothedSample = history[historyOffsetLow + bins - 1] ?? minDecibels
      for (let y = 0; y < plotHeight; y += 1) {
        const binPosition = ((plotHeight - 1 - y) / Math.max(plotHeight - 1, 1)) * (bins - 1)
        const lowSample = sampleInterpolatedOffsetValue(history, historyOffsetLow, bins, binPosition, minDecibels)
        const highSample = sampleInterpolatedOffsetValue(history, historyOffsetHigh, bins, binPosition, minDecibels)
        const sample = lowSample + (highSample - lowSample) * sourceBlend
        smoothedSample += (sample - smoothedSample) * SPECTROGRAM_VERTICAL_SMOOTH_ALPHA
        const [red, green, blue] = amplitudeToRgb(smoothedSample, minDecibels, maxDecibels)
        const pixelOffset = y * 4
        pixels[pixelOffset] = red
        pixels[pixelOffset + 1] = green
        pixels[pixelOffset + 2] = blue
        pixels[pixelOffset + 3] = 255
      }

      this.spectrogramCtx.putImageData(imageData, x, 0)
    }

    this.renderComposite()
  }

  getPlotMetrics(): PlotMetrics {
    return this.metrics
  }

  clear(): void {
    if (!this.spectrogramCtx) {
      return
    }

    this.resizeForContainer()
    this.spectrogramCtx.fillStyle = BACKGROUND_COLOR
    this.spectrogramCtx.fillRect(0, 0, this.metrics.plotWidth, this.metrics.plotHeight)
    this.renderComposite()
  }

  private ensureColumnImageData(height: number): ImageData {
    if (!this.columnImageData || this.columnImageData.height !== height) {
      if (!this.spectrogramCtx) {
        throw new Error('Missing spectrogram context.')
      }
      this.columnImageData = this.spectrogramCtx.createImageData(1, height)
    }

    return this.columnImageData
  }

  private redrawAxesLayer(): void {
    if (!this.axesCtx) {
      return
    }

    const { plotX, plotY, plotWidth, plotHeight, canvasWidth, canvasHeight } = this.metrics
    const { timeWindowSec, timeLabelOffsetSec, frequencyMinHz, frequencyMaxHz, xTicksSec, yTickCount } =
      this.axisConfig

    const safeTickCount = Math.max(2, yTickCount)
    const safeWindowSec = Math.max(0.1, timeWindowSec)
    const spanHz = Math.max(1, frequencyMaxHz - frequencyMinHz)

    this.axesCtx.clearRect(0, 0, canvasWidth, canvasHeight)

    this.axesCtx.strokeStyle = AXIS_COLOR
    this.axesCtx.lineWidth = 1

    this.axesCtx.beginPath()
    this.axesCtx.rect(plotX + 0.5, plotY + 0.5, plotWidth - 1, plotHeight - 1)
    this.axesCtx.stroke()

    this.axesCtx.strokeStyle = GRID_COLOR
    this.axesCtx.lineWidth = 1

    for (let index = 0; index < safeTickCount; index += 1) {
      const ratio = index / Math.max(safeTickCount - 1, 1)
      const y = Math.round(plotY + ratio * plotHeight) + 0.5

      this.axesCtx.beginPath()
      this.axesCtx.moveTo(plotX + 0.5, y)
      this.axesCtx.lineTo(plotX + plotWidth + 0.5, y)
      this.axesCtx.stroke()
    }

    this.axesCtx.fillStyle = LABEL_COLOR
    this.axesCtx.font = '12px "Avenir Next", "Yu Gothic", sans-serif'
    this.axesCtx.textBaseline = 'middle'

    for (let index = 0; index < safeTickCount; index += 1) {
      const ratio = index / Math.max(safeTickCount - 1, 1)
      const y = Math.round(plotY + ratio * plotHeight)
      const valueHz = Math.round(frequencyMaxHz - ratio * spanHz)

      this.axesCtx.strokeStyle = AXIS_COLOR
      this.axesCtx.beginPath()
      this.axesCtx.moveTo(plotX - TICK_SIZE_PX, y + 0.5)
      this.axesCtx.lineTo(plotX + 0.5, y + 0.5)
      this.axesCtx.stroke()

      this.axesCtx.textAlign = 'right'
      this.axesCtx.fillText(this.numberFormatter.format(Math.max(0, valueHz)), plotX - TICK_SIZE_PX - 4, y)
    }

    this.axesCtx.textBaseline = 'top'
    for (let index = 0; index < xTicksSec.length; index += 1) {
      const tickSec = xTicksSec[index] ?? 0
      const ratio = clamp(tickSec / safeWindowSec, 0, 1)
      const x = Math.round(plotX + ratio * plotWidth)

      this.axesCtx.strokeStyle = AXIS_COLOR
      this.axesCtx.beginPath()
      this.axesCtx.moveTo(x + 0.5, plotY + plotHeight - 0.5)
      this.axesCtx.lineTo(x + 0.5, plotY + plotHeight + TICK_SIZE_PX)
      this.axesCtx.stroke()

      if (index === 0) {
        this.axesCtx.textAlign = 'left'
      } else if (index === xTicksSec.length - 1) {
        this.axesCtx.textAlign = 'right'
      } else {
        this.axesCtx.textAlign = 'center'
      }
      const labelValue = tickSec + timeLabelOffsetSec
      const tickLabel =
        Math.abs(labelValue - Math.round(labelValue)) < 1e-6
          ? String(Math.round(labelValue))
          : labelValue.toFixed(1)
      this.axesCtx.fillText(tickLabel, x, plotY + plotHeight + TICK_SIZE_PX + 3)
    }

    this.axesCtx.textAlign = 'right'
    this.axesCtx.textBaseline = 'alphabetic'
    this.axesCtx.fillText('Time [s]', plotX + plotWidth, canvasHeight - 4)

    this.axesCtx.save()
    this.axesCtx.translate(16, plotY + plotHeight / 2)
    this.axesCtx.rotate(-Math.PI / 2)
    this.axesCtx.textAlign = 'center'
    this.axesCtx.textBaseline = 'alphabetic'
    this.axesCtx.fillText('Frequency [Hz]', 0, 0)
    this.axesCtx.restore()
  }

  private renderComposite(): void {
    if (!this.ctx || !this.canvas) {
      return
    }

    const { canvasWidth, canvasHeight, plotX, plotY } = this.metrics

    this.ctx.fillStyle = BACKGROUND_COLOR
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    this.ctx.drawImage(this.spectrogramCanvas, plotX, plotY)
    this.ctx.drawImage(this.axesCanvas, 0, 0)
    this.drawCursorOverlay()
  }

  private drawCursorOverlay(): void {
    if (!this.ctx || !this.cursorOverlay) {
      return
    }
    const ctx = this.ctx

    const safeWindowSec = Math.max(0.1, this.axisConfig.timeWindowSec)
    const visibleMinSec = this.axisConfig.timeLabelOffsetSec
    const visibleMaxSec = visibleMinSec + safeWindowSec
    const { plotX, plotY, plotWidth, plotHeight } = this.metrics

    const drawLineAt = (seconds: number, color: string): void => {
      if (seconds < visibleMinSec || seconds > visibleMaxSec) {
        return
      }
      const ratio = clamp((seconds - visibleMinSec) / safeWindowSec, 0, 1)
      const x = Math.round(plotX + ratio * plotWidth) + 0.5
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, plotY + 0.5)
      ctx.lineTo(x, plotY + plotHeight - 0.5)
      ctx.stroke()
    }

    if (this.cursorOverlay.mode === 'single') {
      drawLineAt(this.cursorOverlay.singleSec, CURSOR_SINGLE_COLOR)
      return
    }

    drawLineAt(this.cursorOverlay.rangeMinSec, CURSOR_MIN_COLOR)
    drawLineAt(this.cursorOverlay.rangeMaxSec, CURSOR_MAX_COLOR)
  }
}

export function createRenderer(): Renderer {
  return new SpectrogramRenderer()
}
