import type { FrameSize } from '../app/types'

const DEFAULT_REFERENCE_PRESSURE_PA = 2e-5
const DEFAULT_PCM_TO_PRESSURE_GAIN = 1
const MIN_PRESSURE_PA = 1e-12
const DECIBEL_FLOOR = -160
const TWO_PI = Math.PI * 2

export interface StftTransformer {
  readonly frameSize: FrameSize
  readonly frequencyBinCount: number
  transform(frame: Float32Array): Float32Array
}

interface CreateStftTransformerOptions {
  frameSize: FrameSize
  referencePressurePa?: number
  pcmToPressureGain?: number
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

function createBitReversedTable(size: number): Uint32Array<ArrayBuffer> {
  const bitCount = Math.round(Math.log2(size))
  const table = new Uint32Array(size)

  for (let index = 0; index < size; index += 1) {
    let reversed = 0
    let source = index

    for (let bit = 0; bit < bitCount; bit += 1) {
      reversed = (reversed << 1) | (source & 1)
      source >>= 1
    }

    table[index] = reversed
  }

  return table
}

function createHannWindow(size: number): Float32Array<ArrayBuffer> {
  const window = new Float32Array(size)
  if (size === 1) {
    window[0] = 1
    return window
  }

  const denominator = size - 1
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((TWO_PI * index) / denominator)
  }

  return window
}

class Radix2StftTransformer implements StftTransformer {
  readonly frameSize: FrameSize
  readonly frequencyBinCount: number

  private readonly referencePressurePa: number
  private readonly pcmToPressureGain: number
  private readonly coherentGain: number
  private readonly baseScale: number
  private readonly singleSidedScale: number
  private readonly window: Float32Array<ArrayBuffer>
  private readonly fftReal: Float64Array<ArrayBuffer>
  private readonly fftImag: Float64Array<ArrayBuffer>
  private readonly spectrumDb: Float32Array<ArrayBuffer>
  private readonly bitReversedTable: Uint32Array<ArrayBuffer>
  private readonly cosTable: Float64Array<ArrayBuffer>
  private readonly sinTable: Float64Array<ArrayBuffer>

  constructor(options: CreateStftTransformerOptions) {
    if (!isPowerOfTwo(options.frameSize)) {
      throw new Error('Frame size must be a power of two.')
    }

    this.frameSize = options.frameSize
    this.frequencyBinCount = options.frameSize / 2
    this.referencePressurePa = Math.max(MIN_PRESSURE_PA, options.referencePressurePa ?? DEFAULT_REFERENCE_PRESSURE_PA)
    this.pcmToPressureGain = Math.max(MIN_PRESSURE_PA, options.pcmToPressureGain ?? DEFAULT_PCM_TO_PRESSURE_GAIN)

    this.window = createHannWindow(options.frameSize)
    this.fftReal = new Float64Array(options.frameSize)
    this.fftImag = new Float64Array(options.frameSize)
    this.spectrumDb = new Float32Array(this.frequencyBinCount)
    this.bitReversedTable = createBitReversedTable(options.frameSize)
    this.cosTable = new Float64Array(options.frameSize / 2)
    this.sinTable = new Float64Array(options.frameSize / 2)

    let windowSum = 0
    for (let index = 0; index < this.window.length; index += 1) {
      windowSum += this.window[index] ?? 0
    }

    this.coherentGain = Math.max(MIN_PRESSURE_PA, windowSum / options.frameSize)
    this.baseScale = 1 / (options.frameSize * this.coherentGain)
    this.singleSidedScale = 2 * this.baseScale

    for (let index = 0; index < this.cosTable.length; index += 1) {
      const angle = (TWO_PI * index) / options.frameSize
      this.cosTable[index] = Math.cos(angle)
      this.sinTable[index] = Math.sin(angle)
    }
  }

  transform(frame: Float32Array): Float32Array {
    for (let index = 0; index < this.frameSize; index += 1) {
      const sourceSample = index < frame.length ? (frame[index] ?? 0) : 0
      const sample = Math.max(-1, Math.min(1, sourceSample))
      const windowedSample = sample * (this.window[index] ?? 0)
      const reversedIndex = this.bitReversedTable[index] ?? 0
      this.fftReal[reversedIndex] = windowedSample
      this.fftImag[reversedIndex] = 0
    }

    for (let stageSize = 2; stageSize <= this.frameSize; stageSize <<= 1) {
      const halfSize = stageSize >> 1
      const tableStep = this.frameSize / stageSize

      for (let stageOffset = 0; stageOffset < this.frameSize; stageOffset += stageSize) {
        let tableIndex = 0

        for (let pair = 0; pair < halfSize; pair += 1) {
          const lowerIndex = stageOffset + pair
          const upperIndex = lowerIndex + halfSize

          const realLower = this.fftReal[lowerIndex] ?? 0
          const imagLower = this.fftImag[lowerIndex] ?? 0
          const realUpper = this.fftReal[upperIndex] ?? 0
          const imagUpper = this.fftImag[upperIndex] ?? 0
          const twiddleCos = this.cosTable[tableIndex] ?? 0
          const twiddleSin = this.sinTable[tableIndex] ?? 0

          const tempReal = realUpper * twiddleCos + imagUpper * twiddleSin
          const tempImag = imagUpper * twiddleCos - realUpper * twiddleSin

          this.fftReal[upperIndex] = realLower - tempReal
          this.fftImag[upperIndex] = imagLower - tempImag
          this.fftReal[lowerIndex] = realLower + tempReal
          this.fftImag[lowerIndex] = imagLower + tempImag

          tableIndex += tableStep
        }
      }
    }

    for (let bin = 0; bin < this.frequencyBinCount; bin += 1) {
      const real = this.fftReal[bin] ?? 0
      const imag = this.fftImag[bin] ?? 0
      const magnitude = Math.hypot(real, imag)
      const amplitudePeak = magnitude * (bin === 0 ? this.baseScale : this.singleSidedScale)
      const amplitudeRms = amplitudePeak / Math.SQRT2
      const pressurePa = Math.max(MIN_PRESSURE_PA, amplitudeRms * this.pcmToPressureGain)
      const decibels = 20 * Math.log10(pressurePa / this.referencePressurePa)
      this.spectrumDb[bin] = Number.isFinite(decibels) ? Math.max(decibels, DECIBEL_FLOOR) : DECIBEL_FLOOR
    }

    return this.spectrumDb
  }
}

export function createStftTransformer(options: CreateStftTransformerOptions): StftTransformer {
  return new Radix2StftTransformer(options)
}
