export interface UIElements {
  loginPage: HTMLElement
  appPage: HTMLElement
  userName: HTMLParagraphElement
  loginButton: HTMLButtonElement
  logoutButton: HTMLButtonElement
  micStatus: HTMLParagraphElement
  startButton: HTMLButtonElement
  stopButton: HTMLButtonElement
  errorMessage: HTMLParagraphElement
  freqMinInput: HTMLInputElement
  freqMaxInput: HTMLInputElement
  freqSlider: HTMLDivElement
  freqSliderSelection: HTMLDivElement
  freqHandleMin: HTMLButtonElement
  freqHandleMax: HTMLButtonElement
  xTicks: HTMLDivElement
  yTicks: HTMLDivElement
  canvas: HTMLCanvasElement
}

function getRequiredElement<T extends HTMLElement>(
  id: string,
  typeName: 'canvas' | 'button' | 'paragraph' | 'section' | 'div' | 'input',
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
    stopButton: getRequiredElement<HTMLButtonElement>('stop-button', 'button'),
    errorMessage: getRequiredElement<HTMLParagraphElement>('error-message', 'paragraph'),
    freqMinInput: getRequiredElement<HTMLInputElement>('freq-min-input', 'input'),
    freqMaxInput: getRequiredElement<HTMLInputElement>('freq-max-input', 'input'),
    freqSlider: getRequiredElement<HTMLDivElement>('freq-slider', 'div'),
    freqSliderSelection: getRequiredElement<HTMLDivElement>('freq-slider-selection', 'div'),
    freqHandleMin: getRequiredElement<HTMLButtonElement>('freq-handle-min', 'button'),
    freqHandleMax: getRequiredElement<HTMLButtonElement>('freq-handle-max', 'button'),
    xTicks: getRequiredElement<HTMLDivElement>('x-ticks', 'div'),
    yTicks: getRequiredElement<HTMLDivElement>('y-ticks', 'div'),
    canvas: getRequiredElement<HTMLCanvasElement>('spectrogram-canvas', 'canvas'),
  }
}
