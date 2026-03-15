import { amplitudeToColor } from './colorMap'

export interface Renderer {
  init(canvas: HTMLCanvasElement): void
  drawColumn(freq: Float32Array): void
  clear(): void
}

class SpectrogramRenderer implements Renderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')

    if (!this.ctx) {
      throw new Error('Failed to initialize 2D canvas context.')
    }

    this.resizeForDisplay()
    this.ctx.imageSmoothingEnabled = false
    this.clear()
  }

  drawColumn(freq: Float32Array): void {
    if (!this.canvas || !this.ctx || freq.length === 0) {
      return
    }

    this.resizeForDisplay()

    const width = this.canvas.width
    const height = this.canvas.height

    this.ctx.drawImage(this.canvas, 1, 0, width - 1, height, 0, 0, width - 1, height)

    for (let y = 0; y < height; y += 1) {
      const binIndex = Math.floor(((height - 1 - y) / Math.max(height - 1, 1)) * (freq.length - 1))
      this.ctx.fillStyle = amplitudeToColor(freq[binIndex] ?? 0)
      this.ctx.fillRect(width - 1, y, 1, 1)
    }
  }

  clear(): void {
    if (!this.canvas || !this.ctx) {
      return
    }

    this.resizeForDisplay()
    this.ctx.fillStyle = 'rgb(2 7 16)'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private resizeForDisplay(): void {
    if (!this.canvas || !this.ctx) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    const displayWidth = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const displayHeight = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))

    if (this.canvas.width === displayWidth && this.canvas.height === displayHeight) {
      return
    }

    this.canvas.width = displayWidth
    this.canvas.height = displayHeight
    this.ctx.imageSmoothingEnabled = false
  }
}

export function createRenderer(): Renderer {
  return new SpectrogramRenderer()
}
