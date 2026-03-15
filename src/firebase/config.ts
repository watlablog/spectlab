import type { FirebaseOptions } from 'firebase/app'
import { loadFirebaseEnv } from '../utils/env'

export interface FirebaseConfigLoadResult {
  config: FirebaseOptions | null
  missingKeys: string[]
}

export function getFirebaseConfig(): FirebaseConfigLoadResult {
  return loadFirebaseEnv(import.meta.env)
}
