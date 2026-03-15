import './style.css'
import { bootstrapApp } from './app/app'
import { toErrorMessage } from './utils/errors'

try {
  bootstrapApp()
} catch (error) {
  const message = toErrorMessage(error, 'アプリの初期化に失敗しました。')
  const root = document.getElementById('app')
  if (root) {
    root.innerHTML = `<p class=\"error\">${message}</p>`
  }
}
