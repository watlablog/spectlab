import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'

export interface AuthService {
  readonly isEnabled: boolean
  subscribeAuthState(cb: (user: User | null) => void): () => void
  signInWithGoogle(): Promise<void>
  signOut(): Promise<void>
}

const POPUP_FALLBACK_CODES = new Set([
  'auth/popup-blocked',
  'auth/cancelled-popup-request',
  'auth/operation-not-supported-in-this-environment',
])

function shouldUseRedirect(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  const code = String((error as { code: unknown }).code)
  return POPUP_FALLBACK_CODES.has(code)
}

export function createAuthService(auth: Auth | null): AuthService {
  if (!auth) {
    return {
      isEnabled: false,
      subscribeAuthState: (cb) => {
        cb(null)
        return () => {}
      },
      signInWithGoogle: async () => {
        throw new Error('Firebase Auth is not configured.')
      },
      signOut: async () => {
        throw new Error('Firebase Auth is not configured.')
      },
    }
  }

  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })

  return {
    isEnabled: true,
    subscribeAuthState: (cb) => onAuthStateChanged(auth, cb),
    signInWithGoogle: async () => {
      try {
        await signInWithPopup(auth, provider)
      } catch (error) {
        if (shouldUseRedirect(error)) {
          await signInWithRedirect(auth, provider)
          return
        }
        throw error
      }
    },
    signOut: () => signOut(auth),
  }
}
