export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'
export type FrameSize = 512 | 1024 | 2048 | 4096 | 8192
export type UpperFrequencyHz = 5000 | 10000 | 20000

export interface AppState {
  authEnabled: boolean
  authStatus: AuthStatus
  userName: string | null
  analysisSource: 'live' | 'file'
  isRecording: boolean
  isPlayingBack: boolean
  isSavingAudio: boolean
  isLoadingFile: boolean
  hasMicPermission: boolean
  audioReady: boolean
  loadedAudioName: string | null
  loadedAudioDurationSec: number | null
  currentSampleRateHz: number | null
  analysisFrameSize: FrameSize
  analysisOverlapPercent: number
  analysisUpperFrequencyHz: UpperFrequencyHz
  decibelMin: number
  decibelMax: number
  frequencyDomainMinHz: number
  frequencyDomainMaxHz: number
  frequencyMinHz: number
  frequencyMaxHz: number
  timeDomainMinSec: number
  timeDomainMaxSec: number
  timeMinSec: number
  timeMaxSec: number
  errorMessage: string | null
}

export type StateSubscriber = (state: AppState) => void
