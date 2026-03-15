export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

export interface AppState {
  authStatus: AuthStatus
  userName: string | null
  isRecording: boolean
  hasMicPermission: boolean
  audioReady: boolean
  frequencyDomainMinHz: number
  frequencyDomainMaxHz: number
  frequencyMinHz: number
  frequencyMaxHz: number
  errorMessage: string | null
}

export type StateSubscriber = (state: AppState) => void
