import type { FirebaseOptions } from 'firebase/app'

const FIREBASE_REQUIRED_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

export interface FirebaseEnvResult {
  config: FirebaseOptions | null
  missingKeys: string[]
}

export function loadFirebaseEnv(env: ImportMetaEnv): FirebaseEnvResult {
  const missingKeys = FIREBASE_REQUIRED_KEYS.filter((key) => !env[key] || env[key]?.trim().length === 0)

  if (missingKeys.length > 0) {
    return {
      config: null,
      missingKeys: [...missingKeys],
    }
  }

  return {
    config: {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
      measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
    },
    missingKeys: [],
  }
}
