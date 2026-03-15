function lerp(from: number, to: number, ratio: number): number {
  return Math.round(from + (to - from) * ratio)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function interpolateColor(
  from: [number, number, number],
  to: [number, number, number],
  ratio: number,
): [number, number, number] {
  return [
    lerp(from[0], to[0], ratio),
    lerp(from[1], to[1], ratio),
    lerp(from[2], to[2], ratio),
  ]
}

const REFERENCE_PRESSURE = 2e-5
const DB_SCALE = 20
const MIN_DECIBELS = -90
const MAX_DECIBELS = -10
const MIN_PRESSURE = REFERENCE_PRESSURE * 1e-9

function decibelsToLinearPressure(decibels: number): number {
  return REFERENCE_PRESSURE * Math.pow(10, decibels / DB_SCALE)
}

function linearPressureToDecibels(linearPressure: number): number {
  // dB = 20 * log10(LIN / 2e-5)
  const safePressure = Math.max(linearPressure, MIN_PRESSURE)
  return DB_SCALE * Math.log10(safePressure / REFERENCE_PRESSURE)
}

export function amplitudeToColor(decibels: number): string {
  const safeDecibels = Number.isFinite(decibels) ? decibels : MIN_DECIBELS
  const linearPressure = decibelsToLinearPressure(safeDecibels)
  const dbValue = linearPressureToDecibels(linearPressure)
  const normalized = clamp01((dbValue - MIN_DECIBELS) / (MAX_DECIBELS - MIN_DECIBELS))

  let color: [number, number, number]
  if (normalized < 0.33) {
    color = interpolateColor([2, 8, 22], [32, 101, 255], normalized / 0.33)
  } else if (normalized < 0.66) {
    color = interpolateColor([32, 101, 255], [72, 212, 130], (normalized - 0.33) / 0.33)
  } else {
    color = interpolateColor([72, 212, 130], [255, 96, 28], (normalized - 0.66) / 0.34)
  }

  return `rgb(${color[0]} ${color[1]} ${color[2]})`
}
