import type { WaveformEnvelopeResult } from '../audio/waveform'
import type { PlotMetrics } from './canvas'

const MOBILE_BREAKPOINT_PX = 760
const DESKTOP_DPR_CAP = 2
const MOBILE_DPR_CAP = 1.5
const AMPLITUDE_TICK_COUNT = 5
const BACKGROUND_COLOR = 'rgb(2 8 18)'
const AXIS_COLOR = 'rgba(156, 189, 236, 0.86)'
const GRID_COLOR = 'rgba(120, 156, 203, 0.26)'
const LABEL_COLOR = 'rgb(166 189 220)'
const WAVEFORM_COLOR = 'rgb(108 214 255)'
const ZERO_LINE_COLOR = 'rgba(255, 255, 255, 0.34)'
const SILENCE_EPSILON = 1e-6

export interface WaveformRenderConfig {
  timeMinSec: number
  timeMaxSec: number
  xTicksSec: number[]
  isAmplitudeNormalizationApplied: boolean
}

export interface WaveformRenderer {
  init(canvas: HTMLCanvasElement): void
  resizeForContainer(): PlotMetrics
  getPlotMetrics(): PlotMetrics
  render(envelope: WaveformEnvelopeResult | null, config: WaveformRenderConfig): void
  clear(config: WaveformRenderConfig): void
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

function formatTimeTick(seconds: number): string {
  if (Math.abs(seconds - Math.round(seconds)) < 1e-6) {
    return String(Math.round(seconds))
  }
  return seconds.toFixed(1)
}

function formatAmplitudeTick(amplitude: number): string {
  const absolute = Math.abs(amplitude)
  if (absolute < SILENCE_EPSILON) {
    return '0'
  }
  if (absolute >= 0.1) {
    return amplitude.toFixed(2)
  }
  if (absolute >= 0.001) {
    return amplitude.toFixed(3)
  }
  return amplitude.toExponential(1)
}

class CanvasWaveformRenderer implements WaveformRenderer {
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private metrics: PlotMetrics = {
    plotX: 0,
    plotY: 0,
    plotWidth: 1,
    plotHeight: 1,
    canvasWidth: 1,
    canvasHeight: 1,
    dpr: 1,
  }

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.context = canvas.getContext('2d')
    if (!this.context) {
      throw new Error('Failed to initialize waveform canvas context.')
    }
    this.resizeForContainer()
  }

  resizeForContainer(): PlotMetrics {
    if (!this.canvas || !this.context) {
      return this.metrics
    }

    const dprCap = isMobileViewport() ? MOBILE_DPR_CAP : DESKTOP_DPR_CAP
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap))
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    const marginLeft = isMobileViewport() ? 50 : 58
    const marginRight = 12
    const marginTop = 10
    const marginBottom = 30

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }

    this.metrics = {
      plotX: marginLeft,
      plotY: marginTop,
      plotWidth: Math.max(1, width - marginLeft - marginRight),
      plotHeight: Math.max(1, height - marginTop - marginBottom),
      canvasWidth: width,
      canvasHeight: height,
      dpr,
    }
    return this.metrics
  }

  getPlotMetrics(): PlotMetrics {
    return this.metrics
  }

  render(envelope: WaveformEnvelopeResult | null, config: WaveformRenderConfig): void {
    if (!this.context) {
      return
    }
    const metrics = this.resizeForContainer()
    const { plotX, plotY, plotWidth, plotHeight, canvasWidth, canvasHeight } = metrics
    const context = this.context

    let peak = 0
    let validColumns = 0
    if (envelope) {
      const count = Math.min(envelope.minValues.length, envelope.maxValues.length)
      for (let index = 0; index < count; index += 1) {
        const minValue = envelope.minValues[index] ?? Number.NaN
        const maxValue = envelope.maxValues[index] ?? Number.NaN
        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
          continue
        }
        peak = Math.max(peak, Math.abs(minValue), Math.abs(maxValue))
        validColumns += 1
      }
    }
    const amplitudeLimit = config.isAmplitudeNormalizationApplied
      ? peak > 1 + SILENCE_EPSILON
        ? peak * 1.05
        : 1
      : peak > SILENCE_EPSILON
        ? peak * 1.05
        : 1

    context.fillStyle = BACKGROUND_COLOR
    context.fillRect(0, 0, canvasWidth, canvasHeight)
    context.strokeStyle = AXIS_COLOR
    context.lineWidth = 1
    context.strokeRect(plotX + 0.5, plotY + 0.5, plotWidth - 1, plotHeight - 1)

    context.strokeStyle = GRID_COLOR
    context.fillStyle = LABEL_COLOR
    context.font = '11px "Avenir Next", "Yu Gothic", sans-serif'
    context.textBaseline = 'middle'
    context.textAlign = 'right'
    for (let index = 0; index < AMPLITUDE_TICK_COUNT; index += 1) {
      const ratio = index / Math.max(AMPLITUDE_TICK_COUNT - 1, 1)
      const y = Math.round(plotY + ratio * plotHeight) + 0.5
      const value = amplitudeLimit - ratio * amplitudeLimit * 2
      context.beginPath()
      context.moveTo(plotX + 0.5, y)
      context.lineTo(plotX + plotWidth + 0.5, y)
      context.stroke()
      context.fillText(formatAmplitudeTick(value), plotX - 6, y)
    }

    const timeSpanSec = Math.max(0.1, config.timeMaxSec - config.timeMinSec)
    context.textBaseline = 'top'
    for (let index = 0; index < config.xTicksSec.length; index += 1) {
      const tickSec = config.xTicksSec[index] ?? 0
      const ratio = clamp(tickSec / timeSpanSec, 0, 1)
      const x = Math.round(plotX + ratio * plotWidth)
      if (index === 0) {
        context.textAlign = 'left'
      } else if (index === config.xTicksSec.length - 1) {
        context.textAlign = 'right'
      } else {
        context.textAlign = 'center'
      }
      context.fillText(formatTimeTick(config.timeMinSec + tickSec), x, plotY + plotHeight + 6)
    }

    context.textAlign = 'right'
    context.textBaseline = 'alphabetic'
    context.fillText('Time [s]', plotX + plotWidth, canvasHeight - 4)
    context.save()
    context.translate(14, plotY + plotHeight / 2)
    context.rotate(-Math.PI / 2)
    context.textAlign = 'center'
    context.fillText('Amplitude', 0, 0)
    context.restore()

    const zeroY = plotY + plotHeight / 2
    context.strokeStyle = ZERO_LINE_COLOR
    context.beginPath()
    context.moveTo(plotX + 0.5, zeroY + 0.5)
    context.lineTo(plotX + plotWidth + 0.5, zeroY + 0.5)
    context.stroke()

    if (!envelope || validColumns <= 0) {
      context.fillStyle = LABEL_COLOR
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText('No waveform data', plotX + plotWidth / 2, plotY + plotHeight / 2)
      return
    }

    const count = Math.min(envelope.minValues.length, envelope.maxValues.length)
    context.strokeStyle = WAVEFORM_COLOR
    context.lineWidth = Math.max(1, metrics.dpr * 0.75)
    context.beginPath()
    for (let index = 0; index < count; index += 1) {
      const minValue = envelope.minValues[index] ?? Number.NaN
      const maxValue = envelope.maxValues[index] ?? Number.NaN
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
        continue
      }
      const x = plotX + ((index + 0.5) / count) * plotWidth
      const minY = plotY + clamp((amplitudeLimit - minValue) / (amplitudeLimit * 2), 0, 1) * plotHeight
      const maxY = plotY + clamp((amplitudeLimit - maxValue) / (amplitudeLimit * 2), 0, 1) * plotHeight
      context.moveTo(x, minY)
      context.lineTo(x, maxY)
    }
    context.stroke()
  }

  clear(config: WaveformRenderConfig): void {
    this.render(null, config)
  }
}

export function createWaveformRenderer(): WaveformRenderer {
  return new CanvasWaveformRenderer()
}
