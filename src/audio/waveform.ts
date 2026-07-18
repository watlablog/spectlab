export interface WaveformEnvelopeRequest {
  timeMinSec: number
  timeMaxSec: number
  columnCount: number
}

export interface WaveformEnvelopeResult {
  minValues: Float32Array
  maxValues: Float32Array
}

export type WaveformRangeReader = (startSample: number, endSample: number) => readonly [number, number] | null

const FILE_INDEX_BASE_BLOCK_SAMPLES = 256

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function readWaveformRangeDirect(
  samples: Float32Array,
  startSample: number,
  endSample: number,
): readonly [number, number] | null {
  const start = clamp(Math.floor(startSample), 0, samples.length)
  const end = clamp(Math.ceil(endSample), start, samples.length)
  if (end <= start) {
    return null
  }

  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  for (let index = start; index < end; index += 1) {
    const sample = samples[index] ?? 0
    if (!Number.isFinite(sample)) {
      continue
    }
    minValue = Math.min(minValue, sample)
    maxValue = Math.max(maxValue, sample)
  }

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return null
  }
  return [minValue, maxValue]
}

export function buildWaveformEnvelope(
  startSample: number,
  endSample: number,
  validStartSample: number,
  validEndSample: number,
  columnCount: number,
  readRange: WaveformRangeReader,
): WaveformEnvelopeResult {
  const safeColumnCount = Math.max(1, Math.round(columnCount))
  const minValues = new Float32Array(safeColumnCount)
  const maxValues = new Float32Array(safeColumnCount)
  minValues.fill(Number.NaN)
  maxValues.fill(Number.NaN)

  const safeStart = Math.floor(startSample)
  const safeEnd = Math.max(safeStart + 1, Math.ceil(endSample))
  const spanSamples = safeEnd - safeStart
  const validStart = Math.max(safeStart, Math.floor(validStartSample))
  const validEnd = Math.min(safeEnd, Math.ceil(validEndSample))
  if (validEnd <= validStart) {
    return { minValues, maxValues }
  }

  for (let column = 0; column < safeColumnCount; column += 1) {
    const bucketStart = safeStart + Math.floor((column / safeColumnCount) * spanSamples)
    const bucketEnd = safeStart + Math.ceil(((column + 1) / safeColumnCount) * spanSamples)
    const rangeStart = Math.max(bucketStart, validStart)
    const rangeEnd = Math.min(Math.max(bucketEnd, rangeStart + 1), validEnd)
    if (rangeEnd <= rangeStart) {
      continue
    }

    const range = readRange(rangeStart, rangeEnd)
    if (!range) {
      continue
    }
    minValues[column] = range[0]
    maxValues[column] = range[1]
  }

  return { minValues, maxValues }
}

interface WaveformIndexLevel {
  minValues: Float32Array
  maxValues: Float32Array
}

export interface WaveformEnvelopeIndex {
  readRange(startSample: number, endSample: number): readonly [number, number] | null
}

export function createWaveformEnvelopeIndex(samples: Float32Array): WaveformEnvelopeIndex {
  const baseBlockCount = Math.ceil(samples.length / FILE_INDEX_BASE_BLOCK_SAMPLES)
  const baseMinValues = new Float32Array(baseBlockCount)
  const baseMaxValues = new Float32Array(baseBlockCount)

  for (let block = 0; block < baseBlockCount; block += 1) {
    const start = block * FILE_INDEX_BASE_BLOCK_SAMPLES
    const end = Math.min(samples.length, start + FILE_INDEX_BASE_BLOCK_SAMPLES)
    const range = readWaveformRangeDirect(samples, start, end)
    baseMinValues[block] = range?.[0] ?? Number.NaN
    baseMaxValues[block] = range?.[1] ?? Number.NaN
  }

  const levels: WaveformIndexLevel[] = [{ minValues: baseMinValues, maxValues: baseMaxValues }]
  while ((levels.at(-1)?.minValues.length ?? 0) > 1) {
    const previous = levels.at(-1)
    if (!previous) {
      break
    }
    const nextLength = Math.ceil(previous.minValues.length / 2)
    const nextMinValues = new Float32Array(nextLength)
    const nextMaxValues = new Float32Array(nextLength)
    for (let index = 0; index < nextLength; index += 1) {
      const left = index * 2
      const right = left + 1
      const leftMin = previous.minValues[left] ?? Number.NaN
      const rightMin = previous.minValues[right] ?? Number.NaN
      const leftMax = previous.maxValues[left] ?? Number.NaN
      const rightMax = previous.maxValues[right] ?? Number.NaN
      nextMinValues[index] = Number.isFinite(rightMin) ? Math.min(leftMin, rightMin) : leftMin
      nextMaxValues[index] = Number.isFinite(rightMax) ? Math.max(leftMax, rightMax) : leftMax
    }
    levels.push({ minValues: nextMinValues, maxValues: nextMaxValues })
  }

  const mergeLevelValue = (
    levelIndex: number,
    blockIndex: number,
    current: readonly [number, number] | null,
  ): readonly [number, number] | null => {
    const level = levels[levelIndex]
    if (!level) {
      return current
    }
    const minValue = level.minValues[blockIndex] ?? Number.NaN
    const maxValue = level.maxValues[blockIndex] ?? Number.NaN
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return current
    }
    if (!current) {
      return [minValue, maxValue]
    }
    return [Math.min(current[0], minValue), Math.max(current[1], maxValue)]
  }

  return {
    readRange(startSample: number, endSample: number): readonly [number, number] | null {
      const start = clamp(Math.floor(startSample), 0, samples.length)
      const end = clamp(Math.ceil(endSample), start, samples.length)
      if (end <= start) {
        return null
      }

      const firstFullBlock = Math.ceil(start / FILE_INDEX_BASE_BLOCK_SAMPLES)
      const lastFullBlockExclusive = Math.floor(end / FILE_INDEX_BASE_BLOCK_SAMPLES)
      const leftBoundaryEnd = Math.min(end, firstFullBlock * FILE_INDEX_BASE_BLOCK_SAMPLES)
      const rightBoundaryStart = Math.max(leftBoundaryEnd, lastFullBlockExclusive * FILE_INDEX_BASE_BLOCK_SAMPLES)
      let range = readWaveformRangeDirect(samples, start, leftBoundaryEnd)

      let leftBlock = firstFullBlock
      let rightBlock = lastFullBlockExclusive
      let levelIndex = 0
      while (leftBlock < rightBlock) {
        if (leftBlock % 2 === 1) {
          range = mergeLevelValue(levelIndex, leftBlock, range)
          leftBlock += 1
        }
        if (rightBlock % 2 === 1) {
          rightBlock -= 1
          range = mergeLevelValue(levelIndex, rightBlock, range)
        }
        leftBlock = Math.floor(leftBlock / 2)
        rightBlock = Math.floor(rightBlock / 2)
        levelIndex += 1
      }

      const rightBoundary = readWaveformRangeDirect(samples, rightBoundaryStart, end)
      if (!rightBoundary) {
        return range
      }
      if (!range) {
        return rightBoundary
      }
      return [Math.min(range[0], rightBoundary[0]), Math.max(range[1], rightBoundary[1])]
    },
  }
}
