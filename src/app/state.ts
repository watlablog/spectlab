import type { AppState, StateSubscriber } from './types'

const DEFAULT_STATE: AppState = {
  authStatus: 'loading',
  userName: null,
  analysisSource: 'live',
  isRecording: false,
  isPlayingBack: false,
  isSavingAudio: false,
  isLoadingFile: false,
  hasMicPermission: false,
  audioReady: false,
  loadedAudioName: null,
  loadedAudioDurationSec: null,
  currentSampleRateHz: null,
  analysisFrameSize: 4096,
  analysisOverlapPercent: 75,
  analysisUpperFrequencyHz: 10000,
  decibelMin: -20,
  decibelMax: 80,
  frequencyDomainMinHz: 0,
  frequencyDomainMaxHz: 22050,
  frequencyMinHz: 0,
  frequencyMaxHz: 22050,
  timeDomainMinSec: 0,
  timeDomainMaxSec: 10,
  timeMinSec: 0,
  timeMaxSec: 10,
  errorMessage: null,
}

export interface AppStateStore {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (subscriber: StateSubscriber) => () => void
}

export function createAppStateStore(initialPatch: Partial<AppState> = {}): AppStateStore {
  let state: AppState = { ...DEFAULT_STATE, ...initialPatch }
  const subscribers = new Set<StateSubscriber>()

  const emit = () => {
    for (const subscriber of subscribers) {
      subscriber(state)
    }
  }

  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch }
      emit()
    },
    subscribe: (subscriber) => {
      subscribers.add(subscriber)
      subscriber(state)
      return () => {
        subscribers.delete(subscriber)
      }
    },
  }
}
