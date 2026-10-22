import type { BrowserWindow } from 'electron'

const restorers = new WeakMap<BrowserWindow, () => void>()

/** Native dialog completion does not always dispatch another BrowserWindow focus event. */
export function restoreWindowInputFocus(window: BrowserWindow): void {
  restorers.get(window)?.()
}

/** Restore Chromium input focus after the native window becomes active or finishes loading. */
export function registerWindowInputFocus(window: BrowserWindow): void {
  let pending: ReturnType<typeof setImmediate> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const attempt = (remaining: number) => {
    if (window.isDestroyed() || !window.isVisible()) return
    const contents = window.webContents
    if (contents.isDestroyed() || contents.isDevToolsFocused()) return
    // Windows can emit focus before a native modal re-enables its parent. Retry
    // briefly, but never activate a background window or bypass a modal's lock.
    if (!window.isFocused() || !window.isEnabled()) {
      if (remaining > 0) retry = setTimeout(() => { retry = undefined; attempt(remaining - 1) }, 50)
      return
    }
    if (!contents.isFocused()) contents.focus()
  }
  const restore = () => {
    if (retry) { clearTimeout(retry); retry = undefined }
    if (pending) return
    // Native activation/modal teardown must finish before focusing the embedded page.
    pending = setImmediate(() => {
      pending = undefined
      attempt(6)
    })
  }
  restorers.set(window, restore)
  window.on('focus', restore)
  window.on('show', restore)
  window.webContents.on('did-finish-load', restore)
  window.once('closed', () => {
    if (pending) clearImmediate(pending)
    if (retry) clearTimeout(retry)
    restorers.delete(window)
    window.removeListener('focus', restore)
    window.removeListener('show', restore)
    window.webContents.removeListener('did-finish-load', restore)
  })
}

/** Run the picker with its parent and restore page focus on selection, cancellation or error. */
export async function withWindowInputFocus<T>(window: BrowserWindow, action: () => Promise<T>): Promise<T> {
  try { return await action() }
  finally { restoreWindowInputFocus(window) }
}
