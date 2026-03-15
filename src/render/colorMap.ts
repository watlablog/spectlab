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

const DEFAULT_MIN_DECIBELS = -20
const DEFAULT_MAX_DECIBELS = 80

export function amplitudeToRgb(
  decibels: number,
  minDecibels: number,
  maxDecibels: number,
): [number, number, number] {
  const safeMinDecibels = Number.isFinite(minDecibels) ? minDecibels : DEFAULT_MIN_DECIBELS
  const safeMaxDecibels = Number.isFinite(maxDecibels) ? maxDecibels : DEFAULT_MAX_DECIBELS
  const clampedMax = Math.max(safeMinDecibels + 1, safeMaxDecibels)
  const safeDecibels = Number.isFinite(decibels) ? decibels : safeMinDecibels
  const normalized = clamp01((safeDecibels - safeMinDecibels) / (clampedMax - safeMinDecibels))

  let color: [number, number, number]
  if (normalized < 0.33) {
    color = interpolateColor([2, 8, 22], [32, 101, 255], normalized / 0.33)
  } else if (normalized < 0.66) {
    color = interpolateColor([32, 101, 255], [72, 212, 130], (normalized - 0.33) / 0.33)
  } else {
    color = interpolateColor([72, 212, 130], [255, 96, 28], (normalized - 0.66) / 0.34)
  }

  return color
}

export function amplitudeToColor(decibels: number, minDecibels: number, maxDecibels: number): string {
  const [red, green, blue] = amplitudeToRgb(decibels, minDecibels, maxDecibels)
  return `rgb(${red} ${green} ${blue})`
}
