import { bootstrapApp } from './app/app'
import { toErrorMessage } from './utils/errors'
import packageMeta from '../package.json'

const versionElement = document.getElementById('app-version')
if (versionElement) {
  versionElement.textContent = `v${packageMeta.version}`
}

try {
  bootstrapApp()
} catch (error) {
  const message = toErrorMessage(error, 'アプリの初期化に失敗しました。')
  const root = document.getElementById('app')
  if (root) {
    const errorElement = document.createElement('p')
    errorElement.className = 'error'
    errorElement.textContent = message
    root.replaceChildren(errorElement)
  }
}
