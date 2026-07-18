export type AudioFilterType = 'lowpass' | 'highpass' | 'bandpass' | 'bandstop'

export type AudioFilterConfig =
  | {
      type: 'lowpass'
      cutoffHz: number
    }
  | {
      type: 'highpass'
      cutoffHz: number
    }
  | {
      type: 'bandpass'
      lowCutoffHz: number
      highCutoffHz: number
    }
  | {
      type: 'bandstop'
      lowCutoffHz: number
      highCutoffHz: number
    }

export interface AudioFilterProgress {
  generation: number
  percent: number
}

export interface BiquadCoefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface BiquadState {
  z1: number
  z2: number
}

export interface BiquadProcessor {
  processSample(sample: number): number
  process(samples: Float32Array): Float32Array<ArrayBuffer>
  getState(): BiquadState
  setState(state: BiquadState): void
  reset(): void
}

export interface BiquadCascadeProcessor {
  processSample(sample: number): number
  process(samples: Float32Array): Float32Array<ArrayBuffer>
  getStates(): BiquadState[]
  setStates(states: BiquadState[]): void
  reset(): void
}

export const FILTER_MIN_FREQUENCY_HZ = 1
export const FILTER_MAX_NYQUIST_RATIO = 0.99
export const FILTER_MAX_BAND_Q = 100

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function getMaximumFilterFrequencyHz(sampleRateHz: number): number {
  return Math.max(
    FILTER_MIN_FREQUENCY_HZ,
    Math.floor(Math.max(2, sampleRateHz) * 0.5 * FILTER_MAX_NYQUIST_RATIO),
  )
}

export function cloneAudioFilterConfig(config: AudioFilterConfig): AudioFilterConfig {
  if (config.type === 'lowpass' || config.type === 'highpass') {
    return { type: config.type, cutoffHz: config.cutoffHz }
  }
  return {
    type: config.type,
    lowCutoffHz: config.lowCutoffHz,
    highCutoffHz: config.highCutoffHz,
  }
}

export function validateAudioFilterConfig(
  config: AudioFilterConfig,
  sampleRateHz: number,
): string | null {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 2) {
    return 'Audio sample rate is unavailable.'
  }
  const maximumHz = getMaximumFilterFrequencyHz(sampleRateHz)
  if (config.type === 'lowpass' || config.type === 'highpass') {
    if (!Number.isFinite(config.cutoffHz)) {
      return 'Cutoff must be a number.'
    }
    if (config.cutoffHz < FILTER_MIN_FREQUENCY_HZ || config.cutoffHz > maximumHz) {
      return `Cutoff must be between ${FILTER_MIN_FREQUENCY_HZ} and ${maximumHz} Hz.`
    }
    return null
  }

  if (!Number.isFinite(config.lowCutoffHz) || !Number.isFinite(config.highCutoffHz)) {
    return 'Low and High must be numbers.'
  }
  if (
    config.lowCutoffHz < FILTER_MIN_FREQUENCY_HZ ||
    config.highCutoffHz > maximumHz ||
    config.lowCutoffHz >= config.highCutoffHz
  ) {
    return `Low and High must satisfy ${FILTER_MIN_FREQUENCY_HZ} ≤ Low < High ≤ ${maximumHz} Hz.`
  }
  const centerHz = Math.sqrt(config.lowCutoffHz * config.highCutoffHz)
  const bandwidthHz = config.highCutoffHz - config.lowCutoffHz
  const minimumBandwidthHz = Math.max(1, centerHz / FILTER_MAX_BAND_Q)
  if (bandwidthHz < minimumBandwidthHz) {
    return `Bandwidth must be at least ${minimumBandwidthHz.toFixed(1)} Hz.`
  }
  return null
}

export function clampAudioFilterConfig(
  config: AudioFilterConfig,
  sampleRateHz: number,
): AudioFilterConfig {
  const maximumHz = getMaximumFilterFrequencyHz(sampleRateHz)
  if (config.type === 'lowpass' || config.type === 'highpass') {
    return {
      type: config.type,
      cutoffHz: clamp(Math.round(config.cutoffHz), FILTER_MIN_FREQUENCY_HZ, maximumHz),
    }
  }

  let lowCutoffHz = clamp(
    Math.round(config.lowCutoffHz),
    FILTER_MIN_FREQUENCY_HZ,
    Math.max(FILTER_MIN_FREQUENCY_HZ, maximumHz - 1),
  )
  let highCutoffHz = clamp(Math.round(config.highCutoffHz), lowCutoffHz + 1, maximumHz)
  const centerHz = Math.sqrt(lowCutoffHz * highCutoffHz)
  const minimumBandwidthHz = Math.max(1, Math.ceil(centerHz / FILTER_MAX_BAND_Q))
  if (highCutoffHz - lowCutoffHz < minimumBandwidthHz) {
    highCutoffHz = Math.min(maximumHz, lowCutoffHz + minimumBandwidthHz)
    if (highCutoffHz - lowCutoffHz < minimumBandwidthHz) {
      lowCutoffHz = Math.max(FILTER_MIN_FREQUENCY_HZ, highCutoffHz - minimumBandwidthHz)
    }
  }
  return { type: config.type, lowCutoffHz, highCutoffHz }
}

export function createBiquadCoefficients(
  config: AudioFilterConfig,
  sampleRateHz: number,
): BiquadCoefficients {
  const validationError = validateAudioFilterConfig(config, sampleRateHz)
  if (validationError) {
    throw new Error(validationError)
  }

  let frequencyHz: number
  let q: number
  if (config.type === 'lowpass' || config.type === 'highpass') {
    frequencyHz = config.cutoffHz
    q = Math.SQRT1_2
  } else {
    frequencyHz = Math.sqrt(config.lowCutoffHz * config.highCutoffHz)
    q = frequencyHz / (config.highCutoffHz - config.lowCutoffHz)
  }

  const omega = (2 * Math.PI * frequencyHz) / sampleRateHz
  const cosine = Math.cos(omega)
  const sine = Math.sin(omega)
  const alpha = sine / (2 * q)
  let b0: number
  let b1: number
  let b2: number

  switch (config.type) {
    case 'lowpass':
      b0 = (1 - cosine) / 2
      b1 = 1 - cosine
      b2 = b0
      break
    case 'highpass':
      b0 = (1 + cosine) / 2
      b1 = -(1 + cosine)
      b2 = b0
      break
    case 'bandpass':
      b0 = alpha
      b1 = 0
      b2 = -alpha
      break
    case 'bandstop':
      b0 = 1
      b1 = -2 * cosine
      b2 = 1
      break
  }

  const a0 = 1 + alpha
  const coefficients = {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  }
  if (Object.values(coefficients).some((value) => !Number.isFinite(value))) {
    throw new Error('Failed to create finite audio filter coefficients.')
  }
  return coefficients
}

export function createBiquadProcessor(
  coefficients: BiquadCoefficients,
  initialState: BiquadState = { z1: 0, z2: 0 },
): BiquadProcessor {
  let z1 = initialState.z1
  let z2 = initialState.z2

  const processSample = (sample: number): number => {
    const input = Number.isFinite(sample) ? sample : 0
    const output = coefficients.b0 * input + z1
    z1 = coefficients.b1 * input - coefficients.a1 * output + z2
    z2 = coefficients.b2 * input - coefficients.a2 * output
    return Number.isFinite(output) ? output : 0
  }

  return {
    processSample,
    process(samples: Float32Array): Float32Array<ArrayBuffer> {
      const output = new Float32Array(samples.length)
      for (let index = 0; index < samples.length; index += 1) {
        output[index] = processSample(samples[index] ?? 0)
      }
      return output
    },
    getState: () => ({ z1, z2 }),
    setState: (state) => {
      z1 = Number.isFinite(state.z1) ? state.z1 : 0
      z2 = Number.isFinite(state.z2) ? state.z2 : 0
    },
    reset: () => {
      z1 = 0
      z2 = 0
    },
  }
}

export function filterPcm(
  samples: Float32Array,
  sampleRateHz: number,
  config: AudioFilterConfig,
  initialState: BiquadState = { z1: 0, z2: 0 },
): { samples: Float32Array<ArrayBuffer>; finalState: BiquadState } {
  const processor = createBiquadProcessor(createBiquadCoefficients(config, sampleRateHz), initialState)
  const output = processor.process(samples)
  return { samples: output, finalState: processor.getState() }
}

export function createBiquadCascadeProcessor(
  configs: AudioFilterConfig[],
  sampleRateHz: number,
  initialStates: BiquadState[] = [],
): BiquadCascadeProcessor {
  const processors = configs.map((config, index) =>
    createBiquadProcessor(
      createBiquadCoefficients(config, sampleRateHz),
      initialStates[index] ?? { z1: 0, z2: 0 },
    ),
  )
  const processSample = (sample: number): number => {
    let output = Number.isFinite(sample) ? sample : 0
    for (const processor of processors) {
      output = processor.processSample(output)
    }
    return output
  }

  return {
    processSample,
    process(samples: Float32Array): Float32Array<ArrayBuffer> {
      const output = new Float32Array(samples.length)
      for (let index = 0; index < samples.length; index += 1) {
        output[index] = processSample(samples[index] ?? 0)
      }
      return output
    },
    getStates: () => processors.map((processor) => processor.getState()),
    setStates: (states) => {
      processors.forEach((processor, index) => {
        processor.setState(states[index] ?? { z1: 0, z2: 0 })
      })
    },
    reset: () => {
      processors.forEach((processor) => processor.reset())
    },
  }
}

export function filterPcmCascade(
  samples: Float32Array,
  sampleRateHz: number,
  configs: AudioFilterConfig[],
  initialStates: BiquadState[] = [],
): { samples: Float32Array<ArrayBuffer>; finalStates: BiquadState[] } {
  const processor = createBiquadCascadeProcessor(configs, sampleRateHz, initialStates)
  const output = processor.process(samples)
  return { samples: output, finalStates: processor.getStates() }
}
