import { describe, expect, it } from 'vitest'
import {
  createBiquadCoefficients,
  createBiquadCascadeProcessor,
  createBiquadProcessor,
  filterPcm,
  filterPcmCascade,
  getMaximumFilterFrequencyHz,
  validateAudioFilterConfig,
  type AudioFilterConfig,
} from './filter'

const SAMPLE_RATE_HZ = 48_000

function magnitudeAtFrequency(config: AudioFilterConfig, frequencyHz: number): number {
  const coefficients = createBiquadCoefficients(config, SAMPLE_RATE_HZ)
  const omega = (2 * Math.PI * frequencyHz) / SAMPLE_RATE_HZ
  const z1Real = Math.cos(-omega)
  const z1Imag = Math.sin(-omega)
  const z2Real = Math.cos(-2 * omega)
  const z2Imag = Math.sin(-2 * omega)
  const numeratorReal = coefficients.b0 + coefficients.b1 * z1Real + coefficients.b2 * z2Real
  const numeratorImag = coefficients.b1 * z1Imag + coefficients.b2 * z2Imag
  const denominatorReal = 1 + coefficients.a1 * z1Real + coefficients.a2 * z2Real
  const denominatorImag = coefficients.a1 * z1Imag + coefficients.a2 * z2Imag
  return Math.hypot(numeratorReal, numeratorImag) / Math.hypot(denominatorReal, denominatorImag)
}

describe('audio filter coefficients', () => {
  it.each<AudioFilterConfig>([
    { type: 'lowpass', cutoffHz: 5_000 },
    { type: 'highpass', cutoffHz: 300 },
    { type: 'bandpass', lowCutoffHz: 300, highCutoffHz: 3_000 },
    { type: 'bandstop', lowCutoffHz: 49, highCutoffHz: 61 },
  ])('creates finite stable coefficients for $type', (config) => {
    const coefficients = createBiquadCoefficients(config, SAMPLE_RATE_HZ)
    expect(Object.values(coefficients).every(Number.isFinite)).toBe(true)

    const discriminant = coefficients.a1 * coefficients.a1 - 4 * coefficients.a2
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant)
      expect(Math.abs((-coefficients.a1 + root) / 2)).toBeLessThan(1)
      expect(Math.abs((-coefficients.a1 - root) / 2)).toBeLessThan(1)
    } else {
      expect(Math.sqrt(Math.abs(coefficients.a2))).toBeLessThan(1)
    }
  })

  it('has the expected lowpass and highpass response', () => {
    const lowpass = { type: 'lowpass', cutoffHz: 5_000 } as const
    const highpass = { type: 'highpass', cutoffHz: 500 } as const
    expect(magnitudeAtFrequency(lowpass, 100)).toBeGreaterThan(0.99)
    expect(magnitudeAtFrequency(lowpass, 20_000)).toBeLessThan(0.05)
    expect(magnitudeAtFrequency(lowpass, 5_000)).toBeCloseTo(Math.SQRT1_2, 5)
    expect(magnitudeAtFrequency(highpass, 5_000)).toBeGreaterThan(0.99)
    expect(magnitudeAtFrequency(highpass, 20)).toBeLessThan(0.01)
    expect(magnitudeAtFrequency(highpass, 500)).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('has the expected bandpass and bandstop response', () => {
    const bandpass = { type: 'bandpass', lowCutoffHz: 300, highCutoffHz: 3_000 } as const
    const bandstop = { type: 'bandstop', lowCutoffHz: 300, highCutoffHz: 3_000 } as const
    const centerHz = Math.sqrt(300 * 3_000)
    expect(magnitudeAtFrequency(bandpass, centerHz)).toBeCloseTo(1, 5)
    expect(magnitudeAtFrequency(bandpass, 30)).toBeLessThan(0.2)
    expect(magnitudeAtFrequency(bandpass, 12_000)).toBeLessThan(0.2)
    expect(magnitudeAtFrequency(bandstop, centerHz)).toBeLessThan(1e-5)
    expect(magnitudeAtFrequency(bandstop, 30)).toBeGreaterThan(0.99)
    expect(magnitudeAtFrequency(bandstop, 12_000)).toBeGreaterThan(0.98)
  })

  it('stays finite and stable across boundary and representative valid frequencies', () => {
    const maximumHz = getMaximumFilterFrequencyHz(SAMPLE_RATE_HZ)
    const configs: AudioFilterConfig[] = [
      ...[1, 2, 10, 100, 1_000, 10_000, maximumHz].flatMap<AudioFilterConfig>((cutoffHz) => [
        { type: 'lowpass', cutoffHz },
        { type: 'highpass', cutoffHz },
      ]),
      { type: 'bandpass', lowCutoffHz: 1, highCutoffHz: 2 },
      { type: 'bandpass', lowCutoffHz: 300, highCutoffHz: 3_000 },
      { type: 'bandpass', lowCutoffHz: 23_000, highCutoffHz: maximumHz },
      { type: 'bandstop', lowCutoffHz: 49, highCutoffHz: 61 },
      { type: 'bandstop', lowCutoffHz: 9_950, highCutoffHz: 10_050 },
      { type: 'bandstop', lowCutoffHz: 23_000, highCutoffHz: maximumHz },
    ]

    for (const config of configs) {
      expect(validateAudioFilterConfig(config, SAMPLE_RATE_HZ)).toBeNull()
      const coefficients = createBiquadCoefficients(config, SAMPLE_RATE_HZ)
      expect(Object.values(coefficients).every(Number.isFinite)).toBe(true)
      const discriminant = coefficients.a1 * coefficients.a1 - 4 * coefficients.a2
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant)
        expect(Math.abs((-coefficients.a1 + root) / 2)).toBeLessThan(1)
        expect(Math.abs((-coefficients.a1 - root) / 2)).toBeLessThan(1)
      } else {
        expect(Math.sqrt(Math.abs(coefficients.a2))).toBeLessThan(1)
      }
    }
  })
})

describe('audio filter processing', () => {
  it('matches one-shot and chunked processing without modifying the source', () => {
    const source = Float32Array.from({ length: 20_000 }, (_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE_HZ),
    )
    const original = new Float32Array(source)
    const config = { type: 'lowpass', cutoffHz: 2_000 } as const
    const oneShot = filterPcm(source, SAMPLE_RATE_HZ, config).samples
    const processor = createBiquadProcessor(createBiquadCoefficients(config, SAMPLE_RATE_HZ))
    const first = processor.process(source.subarray(0, 7_777))
    const second = processor.process(source.subarray(7_777))
    const chunked = new Float32Array(source.length)
    chunked.set(first)
    chunked.set(second, first.length)

    expect(source).toEqual(original)
    expect(chunked).toEqual(oneShot)
  })

  it('restores an exact range from a saved filter state', () => {
    const source = Float32Array.from({ length: 12_000 }, (_, index) =>
      0.6 * Math.sin((2 * Math.PI * 2_000 * index) / SAMPLE_RATE_HZ),
    )
    const config = { type: 'bandstop', lowCutoffHz: 1_900, highCutoffHz: 2_100 } as const
    const coefficients = createBiquadCoefficients(config, SAMPLE_RATE_HZ)
    const fullProcessor = createBiquadProcessor(coefficients)
    const prefix = fullProcessor.process(source.subarray(0, 4_096))
    expect(prefix.length).toBe(4_096)
    const checkpoint = fullProcessor.getState()
    const expected = fullProcessor.process(source.subarray(4_096, 9_000))
    const restored = createBiquadProcessor(coefficients, checkpoint).process(source.subarray(4_096, 9_000))
    expect(restored).toEqual(expected)
  })

  it('applies multiple filters in order and preserves earlier stages when the last stage is removed', () => {
    const source = Float32Array.from({ length: 24_000 }, (_, index) =>
      0.4 * Math.sin((2 * Math.PI * 100 * index) / SAMPLE_RATE_HZ) +
      0.4 * Math.sin((2 * Math.PI * 1_000 * index) / SAMPLE_RATE_HZ) +
      0.4 * Math.sin((2 * Math.PI * 10_000 * index) / SAMPLE_RATE_HZ),
    )
    const lowpass = { type: 'lowpass', cutoffHz: 2_000 } as const
    const highpass = { type: 'highpass', cutoffHz: 500 } as const
    const lowpassOnly = filterPcmCascade(source, SAMPLE_RATE_HZ, [lowpass]).samples
    const stacked = filterPcmCascade(source, SAMPLE_RATE_HZ, [lowpass, highpass]).samples
    const afterPop = filterPcmCascade(source, SAMPLE_RATE_HZ, [lowpass, highpass].slice(0, -1)).samples

    expect(afterPop).toEqual(lowpassOnly)
    expect(stacked).not.toEqual(lowpassOnly)
    expect(source.some((sample, index) => sample !== stacked[index])).toBe(true)
  })

  it('restores every stage in a filter cascade from checkpoint states', () => {
    const source = Float32Array.from({ length: 16_000 }, (_, index) =>
      0.5 * Math.sin((2 * Math.PI * 700 * index) / SAMPLE_RATE_HZ),
    )
    const configs: AudioFilterConfig[] = [
      { type: 'lowpass', cutoffHz: 4_000 },
      { type: 'highpass', cutoffHz: 200 },
      { type: 'bandstop', lowCutoffHz: 680, highCutoffHz: 720 },
    ]
    const processor = createBiquadCascadeProcessor(configs, SAMPLE_RATE_HZ)
    processor.process(source.subarray(0, 4_096))
    const checkpointStates = processor.getStates()
    const expected = processor.process(source.subarray(4_096, 12_000))
    const restored = createBiquadCascadeProcessor(configs, SAMPLE_RATE_HZ, checkpointStates).process(
      source.subarray(4_096, 12_000),
    )

    expect(restored).toEqual(expected)
  })
})
