import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'

let firebaseAppSingleton: FirebaseApp | null = null
let authSingleton: Auth | null = null

export interface FirebaseServices {
  app: FirebaseApp
  auth: Auth
}

export function initFirebase(config: FirebaseOptions): FirebaseServices {
  if (!firebaseAppSingleton) {
    firebaseAppSingleton = getApps().length > 0 ? getApp() : initializeApp(config)
  }

  if (!authSingleton) {
    authSingleton = getAuth(firebaseAppSingleton)
  }

  return {
    app: firebaseAppSingleton,
    auth: authSingleton,
  }
}
