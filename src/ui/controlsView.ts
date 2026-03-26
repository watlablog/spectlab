import type { AppState } from '../app/types'
import type { UIElements } from './dom'

export function renderControlsView(elements: UIElements, state: AppState, hasSavableAudio: boolean): void {
  const isSignedIn = state.authStatus === 'signed-in'
  const isBusy = state.isSavingAudio || state.isLoadingFile
  elements.startButton.disabled = !isSignedIn || state.isPlayingBack || isBusy
  elements.startButton.classList.toggle('is-recording', state.isRecording)
  elements.startButton.setAttribute('aria-label', state.isRecording ? 'Stop recording' : 'Start recording')
  elements.playbackToggleButton.disabled = !isSignedIn || state.isRecording || isBusy || !hasSavableAudio
  elements.clearButton.disabled = !isSignedIn || state.isRecording || state.isPlayingBack || isBusy
  elements.loadAudioButton.disabled = !isSignedIn || state.isRecording || state.isPlayingBack || isBusy
  elements.saveButton.disabled =
    !isSignedIn || state.isRecording || state.isPlayingBack || isBusy || !hasSavableAudio
  elements.frameSizeSelect.disabled = !isSignedIn || state.isRecording || state.isPlayingBack || isBusy
  elements.overlapInput.disabled = !isSignedIn || state.isRecording || state.isPlayingBack || isBusy
  elements.upperFrequencySelect.disabled = !isSignedIn || state.isRecording || state.isPlayingBack || isBusy

  if (!isSignedIn) {
    elements.micStatus.textContent = 'ログイン後に利用できます。'
    return
  }

  if (state.isLoadingFile) {
    elements.micStatus.textContent = '音声ファイルを読み込み中です。'
    return
  }

  if (state.isRecording) {
    elements.micStatus.textContent = '解析中です。Recordボタンで停止できます。'
    return
  }

  if (state.isPlayingBack) {
    elements.micStatus.textContent = '再生中です。再生ボタンで停止できます。'
    return
  }

  if (state.isSavingAudio) {
    elements.micStatus.textContent = '保存中です。完了までお待ちください。'
    return
  }

  if (state.analysisSource === 'file') {
    const name = state.loadedAudioName ?? 'audio file'
    elements.micStatus.textContent = `File mode: ${name}`
    return
  }

  if (state.hasMicPermission && state.audioReady) {
    elements.micStatus.textContent = '停止中です。Recordで再び解析します。'
    return
  }

  if (state.hasMicPermission) {
    elements.micStatus.textContent = 'マイク許可済み。Recordボタンで解析を始めます。'
    return
  }

  elements.micStatus.textContent = 'Recordボタンを押すとマイク許可を要求します。'
}
