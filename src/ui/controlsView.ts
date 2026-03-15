import type { AppState } from '../app/types'
import type { UIElements } from './dom'

export function renderControlsView(elements: UIElements, state: AppState): void {
  const isSignedIn = state.authStatus === 'signed-in'
  elements.startButton.disabled = !isSignedIn || state.isRecording
  elements.stopButton.disabled = !isSignedIn || !state.isRecording
  elements.frameSizeSelect.disabled = !isSignedIn || state.isRecording
  elements.overlapInput.disabled = !isSignedIn || state.isRecording
  elements.upperFrequencySelect.disabled = !isSignedIn || state.isRecording

  if (!isSignedIn) {
    elements.micStatus.textContent = 'ログイン後に利用できます。'
    return
  }

  if (state.isRecording) {
    elements.micStatus.textContent = '解析中です。停止でリソースを解放します。'
    return
  }

  if (state.hasMicPermission && state.audioReady) {
    elements.micStatus.textContent = '停止中です。開始で再び解析します。'
    return
  }

  if (state.hasMicPermission) {
    elements.micStatus.textContent = 'マイク許可済み。開始ボタンで解析を始めます。'
    return
  }

  elements.micStatus.textContent = '開始ボタンを押すとマイク許可を要求します。'
}
