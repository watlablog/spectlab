export type Rgb = [number, number, number]

export type ColormapCategory =
  | 'SpectLab'
  | 'Perceptually Uniform'
  | 'Sequential'
  | 'Sequential (2)'
  | 'Diverging'
  | 'Cyclic / Misc'

export interface ColormapPreset {
  id: string
  label: string
  category: ColormapCategory
  colors: readonly Rgb[]
}

const DEFAULT_MIN_DECIBELS = -20
const DEFAULT_MAX_DECIBELS = 80
const GRADIENT_SAMPLE_COUNT = 32

export const COLORMAP_PRESETS = [
  {
    id: 'spectlab',
    label: 'SpectLab',
    category: 'SpectLab',
    colors: [
      [2, 8, 22],
      [32, 101, 255],
      [72, 212, 130],
      [255, 96, 28],
    ],
  },
  {
    id: 'viridis',
    label: 'viridis',
    category: 'Perceptually Uniform',
    colors: [
      [68, 1, 84],
      [72, 35, 116],
      [64, 67, 135],
      [52, 94, 141],
      [41, 120, 142],
      [32, 144, 140],
      [34, 167, 132],
      [68, 190, 112],
      [121, 209, 81],
      [189, 223, 38],
      [253, 231, 37],
    ],
  },
  {
    id: 'plasma',
    label: 'plasma',
    category: 'Perceptually Uniform',
    colors: [
      [13, 8, 135],
      [75, 3, 161],
      [125, 3, 168],
      [168, 34, 150],
      [203, 70, 121],
      [229, 107, 93],
      [248, 148, 65],
      [253, 195, 40],
      [240, 249, 33],
    ],
  },
  {
    id: 'inferno',
    label: 'inferno',
    category: 'Perceptually Uniform',
    colors: [
      [0, 0, 4],
      [31, 12, 72],
      [85, 15, 109],
      [136, 34, 106],
      [186, 54, 85],
      [227, 89, 51],
      [249, 140, 10],
      [249, 201, 50],
      [252, 255, 164],
    ],
  },
  {
    id: 'magma',
    label: 'magma',
    category: 'Perceptually Uniform',
    colors: [
      [0, 0, 4],
      [28, 16, 68],
      [79, 18, 123],
      [129, 37, 129],
      [181, 54, 122],
      [229, 80, 100],
      [251, 135, 97],
      [254, 194, 135],
      [252, 253, 191],
    ],
  },
  {
    id: 'cividis',
    label: 'cividis',
    category: 'Perceptually Uniform',
    colors: [
      [0, 32, 76],
      [0, 45, 107],
      [40, 62, 115],
      [76, 78, 111],
      [104, 94, 104],
      [130, 112, 95],
      [158, 131, 83],
      [187, 153, 68],
      [215, 179, 46],
      [254, 233, 69],
    ],
  },
  {
    id: 'Greys',
    label: 'Greys',
    category: 'Sequential',
    colors: [
      [255, 255, 255],
      [240, 240, 240],
      [217, 217, 217],
      [189, 189, 189],
      [150, 150, 150],
      [99, 99, 99],
      [37, 37, 37],
      [0, 0, 0],
    ],
  },
  {
    id: 'Blues',
    label: 'Blues',
    category: 'Sequential',
    colors: [
      [247, 251, 255],
      [222, 235, 247],
      [198, 219, 239],
      [158, 202, 225],
      [107, 174, 214],
      [66, 146, 198],
      [33, 113, 181],
      [8, 81, 156],
      [8, 48, 107],
    ],
  },
  {
    id: 'Greens',
    label: 'Greens',
    category: 'Sequential',
    colors: [
      [247, 252, 245],
      [229, 245, 224],
      [199, 233, 192],
      [161, 217, 155],
      [116, 196, 118],
      [65, 171, 93],
      [35, 139, 69],
      [0, 109, 44],
      [0, 68, 27],
    ],
  },
  {
    id: 'Oranges',
    label: 'Oranges',
    category: 'Sequential',
    colors: [
      [255, 245, 235],
      [254, 230, 206],
      [253, 208, 162],
      [253, 174, 107],
      [253, 141, 60],
      [241, 105, 19],
      [217, 72, 1],
      [166, 54, 3],
      [127, 39, 4],
    ],
  },
  {
    id: 'Reds',
    label: 'Reds',
    category: 'Sequential',
    colors: [
      [255, 245, 240],
      [254, 224, 210],
      [252, 187, 161],
      [252, 146, 114],
      [251, 106, 74],
      [239, 59, 44],
      [203, 24, 29],
      [165, 15, 21],
      [103, 0, 13],
    ],
  },
  {
    id: 'YlOrBr',
    label: 'YlOrBr',
    category: 'Sequential',
    colors: [
      [255, 255, 229],
      [255, 247, 188],
      [254, 227, 145],
      [254, 196, 79],
      [254, 153, 41],
      [236, 112, 20],
      [204, 76, 2],
      [153, 52, 4],
      [102, 37, 6],
    ],
  },
  {
    id: 'YlOrRd',
    label: 'YlOrRd',
    category: 'Sequential',
    colors: [
      [255, 255, 204],
      [255, 237, 160],
      [254, 217, 118],
      [254, 178, 76],
      [253, 141, 60],
      [252, 78, 42],
      [227, 26, 28],
      [189, 0, 38],
      [128, 0, 38],
    ],
  },
  {
    id: 'YlGnBu',
    label: 'YlGnBu',
    category: 'Sequential',
    colors: [
      [255, 255, 217],
      [237, 248, 177],
      [199, 233, 180],
      [127, 205, 187],
      [65, 182, 196],
      [29, 145, 192],
      [34, 94, 168],
      [37, 52, 148],
      [8, 29, 88],
    ],
  },
  {
    id: 'gray',
    label: 'gray',
    category: 'Sequential (2)',
    colors: [
      [0, 0, 0],
      [255, 255, 255],
    ],
  },
  {
    id: 'bone',
    label: 'bone',
    category: 'Sequential (2)',
    colors: [
      [0, 0, 0],
      [42, 42, 58],
      [84, 98, 112],
      [139, 156, 156],
      [199, 205, 193],
      [255, 255, 255],
    ],
  },
  {
    id: 'hot',
    label: 'hot',
    category: 'Sequential (2)',
    colors: [
      [11, 0, 0],
      [96, 0, 0],
      [190, 28, 0],
      [255, 116, 0],
      [255, 205, 32],
      [255, 255, 255],
    ],
  },
  {
    id: 'cool',
    label: 'cool',
    category: 'Sequential (2)',
    colors: [
      [0, 255, 255],
      [255, 0, 255],
    ],
  },
  {
    id: 'copper',
    label: 'copper',
    category: 'Sequential (2)',
    colors: [
      [0, 0, 0],
      [72, 45, 28],
      [144, 90, 56],
      [216, 135, 84],
      [255, 180, 112],
      [255, 229, 143],
    ],
  },
  {
    id: 'coolwarm',
    label: 'coolwarm',
    category: 'Diverging',
    colors: [
      [59, 76, 192],
      [98, 130, 234],
      [141, 176, 254],
      [184, 208, 249],
      [221, 220, 219],
      [244, 195, 171],
      [239, 138, 98],
      [202, 72, 66],
      [180, 4, 38],
    ],
  },
  {
    id: 'RdBu',
    label: 'RdBu',
    category: 'Diverging',
    colors: [
      [103, 0, 31],
      [178, 24, 43],
      [214, 96, 77],
      [244, 165, 130],
      [247, 247, 247],
      [146, 197, 222],
      [67, 147, 195],
      [33, 102, 172],
      [5, 48, 97],
    ],
  },
  {
    id: 'Spectral',
    label: 'Spectral',
    category: 'Diverging',
    colors: [
      [158, 1, 66],
      [213, 62, 79],
      [244, 109, 67],
      [253, 174, 97],
      [255, 255, 191],
      [171, 221, 164],
      [102, 194, 165],
      [50, 136, 189],
      [94, 79, 162],
    ],
  },
  {
    id: 'seismic',
    label: 'seismic',
    category: 'Diverging',
    colors: [
      [0, 0, 76],
      [0, 0, 170],
      [0, 0, 255],
      [176, 176, 255],
      [255, 255, 255],
      [255, 176, 176],
      [255, 0, 0],
      [170, 0, 0],
      [76, 0, 0],
    ],
  },
  {
    id: 'bwr',
    label: 'bwr',
    category: 'Diverging',
    colors: [
      [0, 0, 255],
      [255, 255, 255],
      [255, 0, 0],
    ],
  },
  {
    id: 'PiYG',
    label: 'PiYG',
    category: 'Diverging',
    colors: [
      [142, 1, 82],
      [197, 27, 125],
      [222, 119, 174],
      [241, 182, 218],
      [247, 247, 247],
      [184, 225, 134],
      [127, 188, 65],
      [77, 146, 33],
      [39, 100, 25],
    ],
  },
  {
    id: 'BrBG',
    label: 'BrBG',
    category: 'Diverging',
    colors: [
      [84, 48, 5],
      [140, 81, 10],
      [191, 129, 45],
      [223, 194, 125],
      [245, 245, 245],
      [128, 205, 193],
      [53, 151, 143],
      [1, 102, 94],
      [0, 60, 48],
    ],
  },
  {
    id: 'twilight',
    label: 'twilight',
    category: 'Cyclic / Misc',
    colors: [
      [226, 217, 226],
      [177, 139, 177],
      [112, 31, 101],
      [47, 57, 144],
      [40, 120, 142],
      [159, 190, 87],
      [218, 181, 87],
      [226, 217, 226],
    ],
  },
  {
    id: 'hsv',
    label: 'hsv',
    category: 'Cyclic / Misc',
    colors: [
      [255, 0, 0],
      [255, 255, 0],
      [0, 255, 0],
      [0, 255, 255],
      [0, 0, 255],
      [255, 0, 255],
      [255, 0, 0],
    ],
  },
  {
    id: 'jet',
    label: 'jet',
    category: 'Cyclic / Misc',
    colors: [
      [0, 0, 128],
      [0, 0, 255],
      [0, 255, 255],
      [255, 255, 0],
      [255, 0, 0],
      [128, 0, 0],
    ],
  },
  {
    id: 'turbo',
    label: 'turbo',
    category: 'Cyclic / Misc',
    colors: [
      [48, 18, 59],
      [70, 95, 206],
      [27, 162, 225],
      [53, 213, 110],
      [174, 236, 51],
      [249, 186, 56],
      [236, 76, 37],
      [122, 4, 3],
    ],
  },
  {
    id: 'terrain',
    label: 'terrain',
    category: 'Cyclic / Misc',
    colors: [
      [51, 51, 153],
      [0, 153, 255],
      [0, 204, 102],
      [230, 230, 128],
      [166, 118, 81],
      [255, 255, 255],
    ],
  },
] as const satisfies readonly ColormapPreset[]

export type ColormapId = (typeof COLORMAP_PRESETS)[number]['id']

export const DEFAULT_COLORMAP_ID: ColormapId = 'spectlab'

const COLORMAP_PRESET_BY_ID = new Map<string, (typeof COLORMAP_PRESETS)[number]>(
  COLORMAP_PRESETS.map((preset) => [preset.id, preset]),
)

function lerp(from: number, to: number, ratio: number): number {
  return Math.round(from + (to - from) * ratio)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function interpolateColor(from: Rgb, to: Rgb, ratio: number): Rgb {
  return [lerp(from[0], to[0], ratio), lerp(from[1], to[1], ratio), lerp(from[2], to[2], ratio)]
}

function getColormapPreset(colormapId: ColormapId): (typeof COLORMAP_PRESETS)[number] {
  return COLORMAP_PRESET_BY_ID.get(colormapId) ?? COLORMAP_PRESETS[0]
}

export function isColormapId(value: string): value is ColormapId {
  return COLORMAP_PRESET_BY_ID.has(value)
}

export function getColormapLabel(colormapId: ColormapId): string {
  return getColormapPreset(colormapId).label
}

export function sampleColormapRgb(normalizedValue: number, colormapId: ColormapId): Rgb {
  const preset = getColormapPreset(colormapId)
  const normalized = clamp01(normalizedValue)
  const maxIndex = preset.colors.length - 1

  if (maxIndex <= 0) {
    return preset.colors[0] ?? [0, 0, 0]
  }

  const position = normalized * maxIndex
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.min(maxIndex, lowerIndex + 1)
  const blend = position - lowerIndex
  return interpolateColor(preset.colors[lowerIndex] ?? preset.colors[0], preset.colors[upperIndex] ?? preset.colors[0], blend)
}

export function buildColormapGradient(
  colormapId: ColormapId,
  direction: 'to right' | 'to bottom' = 'to right',
): string {
  const stops: string[] = []

  for (let index = 0; index < GRADIENT_SAMPLE_COUNT; index += 1) {
    const ratio = index / Math.max(GRADIENT_SAMPLE_COUNT - 1, 1)
    const normalized = direction === 'to bottom' ? 1 - ratio : ratio
    const [red, green, blue] = sampleColormapRgb(normalized, colormapId)
    const percent = Math.round(ratio * 1000) / 10
    stops.push(`rgb(${red} ${green} ${blue}) ${percent}%`)
  }

  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

export function amplitudeToRgb(
  decibels: number,
  minDecibels: number,
  maxDecibels: number,
  colormapId: ColormapId = DEFAULT_COLORMAP_ID,
): Rgb {
  const safeMinDecibels = Number.isFinite(minDecibels) ? minDecibels : DEFAULT_MIN_DECIBELS
  const safeMaxDecibels = Number.isFinite(maxDecibels) ? maxDecibels : DEFAULT_MAX_DECIBELS
  const clampedMax = Math.max(safeMinDecibels + 1, safeMaxDecibels)
  const safeDecibels = Number.isFinite(decibels) ? decibels : safeMinDecibels
  const normalized = clamp01((safeDecibels - safeMinDecibels) / (clampedMax - safeMinDecibels))
  return sampleColormapRgb(normalized, colormapId)
}

export function amplitudeToColor(
  decibels: number,
  minDecibels: number,
  maxDecibels: number,
  colormapId: ColormapId = DEFAULT_COLORMAP_ID,
): string {
  const [red, green, blue] = amplitudeToRgb(decibels, minDecibels, maxDecibels, colormapId)
  return `rgb(${red} ${green} ${blue})`
}
