import type { AppState, StateSubscriber } from './types'

const DEFAULT_STATE: AppState = {
  authStatus: 'loading',
  userName: null,
  isRecording: false,
  hasMicPermission: false,
  audioReady: false,
  frequencyDomainMinHz: 0,
  frequencyDomainMaxHz: 22050,
  frequencyMinHz: 0,
  frequencyMaxHz: 22050,
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
