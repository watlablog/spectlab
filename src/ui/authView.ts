import type { AppState } from '../app/types'
import type { UIElements } from './dom'

export function renderAuthView(
  elements: UIElements,
  state: AppState,
  authEnabled: boolean,
  authServiceEnabled: boolean,
  canAccessApp: boolean,
): void {
  if (!authEnabled) {
    elements.loginButton.hidden = true
    elements.logoutButton.hidden = true
    elements.userName.hidden = true
    return
  }

  elements.loginButton.hidden = false
  elements.logoutButton.hidden = false
  elements.userName.hidden = false
  elements.loginButton.textContent = 'Googleでログイン'

  if (!authServiceEnabled) {
    elements.loginButton.textContent = 'ログイン不可'
    elements.userName.textContent = '未ログイン'
    elements.loginButton.disabled = true
    elements.logoutButton.disabled = true
    return
  }

  if (state.authStatus === 'loading') {
    elements.loginButton.textContent = '認証状態を確認中...'
    elements.userName.textContent = '確認中'
    elements.loginButton.disabled = true
    elements.logoutButton.disabled = true
    return
  }

  if (canAccessApp) {
    elements.userName.textContent = state.userName ?? 'ユーザー情報なし'
    elements.loginButton.disabled = true
    elements.logoutButton.disabled = false
    return
  }

  elements.userName.textContent = '未ログイン'
  elements.loginButton.disabled = false
  elements.logoutButton.disabled = true
}
