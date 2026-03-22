export interface UIElements {
  loginPage: HTMLElement
  appPage: HTMLElement
  userName: HTMLParagraphElement
  loginButton: HTMLButtonElement
  logoutButton: HTMLButtonElement
  micStatus: HTMLParagraphElement
  startButton: HTMLButtonElement
  recordActionIcon: HTMLSpanElement
  recordStopActionIcon: HTMLSpanElement
  clearButton: HTMLButtonElement
  clearActionIcon: HTMLSpanElement
  saveActionIcon: HTMLSpanElement
  playbackToggleButton: HTMLButtonElement
  playbackIconPlay: HTMLSpanElement
  playbackIconStop: HTMLSpanElement
  playbackProgressTrack: HTMLDivElement
  playbackProgressFill: HTMLDivElement
  playbackTimeLabel: HTMLDivElement
  saveButton: HTMLButtonElement
  errorMessage: HTMLParagraphElement
  frameSizeSelect: HTMLSelectElement
  overlapInput: HTMLInputElement
  upperFrequencySelect: HTMLSelectElement
  freqMinInput: HTMLInputElement
  freqMaxInput: HTMLInputElement
  freqSlider: HTMLDivElement
  freqSliderSelection: HTMLDivElement
  freqHandleMin: HTMLButtonElement
  freqHandleMax: HTMLButtonElement
  dbSlider: HTMLDivElement
  dbSliderSelection: HTMLDivElement
  dbHandleMin: HTMLButtonElement
  dbHandleMax: HTMLButtonElement
  dbMaxInput: HTMLInputElement
  dbMinInput: HTMLInputElement
  timeSlider: HTMLDivElement
  timeSliderSelection: HTMLDivElement
  timeHandleMin: HTMLButtonElement
  timeHandleMax: HTMLButtonElement
  timeMinInput: HTMLInputElement
  timeMaxInput: HTMLInputElement
  dbTicks: HTMLDivElement
  canvas: HTMLCanvasElement
}

function getRequiredElement<T extends HTMLElement>(
  id: string,
  typeName: 'canvas' | 'button' | 'paragraph' | 'section' | 'div' | 'input' | 'select' | 'span',
): T {
  const element = document.getElementById(id)

  if (!element) {
    throw new Error(`Missing required element: #${id}`)
  }

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element #${id} is not an HTMLElement.`)
  }

  if (typeName === 'canvas' && !(element instanceof HTMLCanvasElement)) {
    throw new Error(`Element #${id} is not a canvas.`)
  }

  if (typeName === 'button' && !(element instanceof HTMLButtonElement)) {
    throw new Error(`Element #${id} is not a button.`)
  }

  if (typeName === 'paragraph' && !(element instanceof HTMLParagraphElement)) {
    throw new Error(`Element #${id} is not a paragraph.`)
  }

  if (typeName === 'div' && !(element instanceof HTMLDivElement)) {
    throw new Error(`Element #${id} is not a div.`)
  }

  if (typeName === 'input' && !(element instanceof HTMLInputElement)) {
    throw new Error(`Element #${id} is not an input.`)
  }

  if (typeName === 'select' && !(element instanceof HTMLSelectElement)) {
    throw new Error(`Element #${id} is not a select.`)
  }

  if (typeName === 'span' && !(element instanceof HTMLSpanElement)) {
    throw new Error(`Element #${id} is not a span.`)
  }

  return element as T
}

export function getUIElements(): UIElements {
  return {
    loginPage: getRequiredElement<HTMLElement>('login-page', 'section'),
    appPage: getRequiredElement<HTMLElement>('app-page', 'section'),
    userName: getRequiredElement<HTMLParagraphElement>('user-name', 'paragraph'),
    loginButton: getRequiredElement<HTMLButtonElement>('login-button', 'button'),
    logoutButton: getRequiredElement<HTMLButtonElement>('logout-button', 'button'),
    micStatus: getRequiredElement<HTMLParagraphElement>('mic-status', 'paragraph'),
    startButton: getRequiredElement<HTMLButtonElement>('start-button', 'button'),
    recordActionIcon: getRequiredElement<HTMLSpanElement>('record-action-icon', 'span'),
    recordStopActionIcon: getRequiredElement<HTMLSpanElement>('record-stop-action-icon', 'span'),
    clearButton: getRequiredElement<HTMLButtonElement>('clear-button', 'button'),
    clearActionIcon: getRequiredElement<HTMLSpanElement>('clear-action-icon', 'span'),
    saveActionIcon: getRequiredElement<HTMLSpanElement>('save-action-icon', 'span'),
    playbackToggleButton: getRequiredElement<HTMLButtonElement>('playback-toggle-button', 'button'),
    playbackIconPlay: getRequiredElement<HTMLSpanElement>('playback-icon-play', 'span'),
    playbackIconStop: getRequiredElement<HTMLSpanElement>('playback-icon-stop', 'span'),
    playbackProgressTrack: getRequiredElement<HTMLDivElement>('playback-progress-track', 'div'),
    playbackProgressFill: getRequiredElement<HTMLDivElement>('playback-progress-fill', 'div'),
    playbackTimeLabel: getRequiredElement<HTMLDivElement>('playback-time-label', 'div'),
    saveButton: getRequiredElement<HTMLButtonElement>('save-button', 'button'),
    errorMessage: getRequiredElement<HTMLParagraphElement>('error-message', 'paragraph'),
    frameSizeSelect: getRequiredElement<HTMLSelectElement>('frame-size-select', 'select'),
    overlapInput: getRequiredElement<HTMLInputElement>('overlap-input', 'input'),
    upperFrequencySelect: getRequiredElement<HTMLSelectElement>('upper-frequency-select', 'select'),
    freqMinInput: getRequiredElement<HTMLInputElement>('freq-min-input', 'input'),
    freqMaxInput: getRequiredElement<HTMLInputElement>('freq-max-input', 'input'),
    freqSlider: getRequiredElement<HTMLDivElement>('freq-slider', 'div'),
    freqSliderSelection: getRequiredElement<HTMLDivElement>('freq-slider-selection', 'div'),
    freqHandleMin: getRequiredElement<HTMLButtonElement>('freq-handle-min', 'button'),
    freqHandleMax: getRequiredElement<HTMLButtonElement>('freq-handle-max', 'button'),
    dbSlider: getRequiredElement<HTMLDivElement>('db-slider', 'div'),
    dbSliderSelection: getRequiredElement<HTMLDivElement>('db-slider-selection', 'div'),
    dbHandleMin: getRequiredElement<HTMLButtonElement>('db-handle-min', 'button'),
    dbHandleMax: getRequiredElement<HTMLButtonElement>('db-handle-max', 'button'),
    dbMaxInput: getRequiredElement<HTMLInputElement>('db-max-input', 'input'),
    dbMinInput: getRequiredElement<HTMLInputElement>('db-min-input', 'input'),
    timeSlider: getRequiredElement<HTMLDivElement>('time-slider', 'div'),
    timeSliderSelection: getRequiredElement<HTMLDivElement>('time-slider-selection', 'div'),
    timeHandleMin: getRequiredElement<HTMLButtonElement>('time-handle-min', 'button'),
    timeHandleMax: getRequiredElement<HTMLButtonElement>('time-handle-max', 'button'),
    timeMinInput: getRequiredElement<HTMLInputElement>('time-min-input', 'input'),
    timeMaxInput: getRequiredElement<HTMLInputElement>('time-max-input', 'input'),
    dbTicks: getRequiredElement<HTMLDivElement>('db-ticks', 'div'),
    canvas: getRequiredElement<HTMLCanvasElement>('spectrogram-canvas', 'canvas'),
  }
}
