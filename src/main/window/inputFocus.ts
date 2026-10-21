import type { BrowserWindow } from 'electron'

/** Restore Chromium input focus after the native window becomes active or finishes loading. */
export function registerWindowInputFocus(window: BrowserWindow): void {
  let pending: ReturnType<typeof setImmediate> | undefined
  const restore = () => {
    if (pending) return
    // Native activation/modal teardown must finish before focusing the embedded page.
    pending = setImmediate(() => {
      pending = undefined
      if (window.isDestroyed() || !window.isVisible() || !window.isFocused() || !window.isEnabled()) return
      const contents = window.webContents
      if (contents.isDestroyed() || contents.isDevToolsFocused() || contents.isFocused()) return
      contents.focus()
    })
  }
  window.on('focus', restore)
  window.on('show', restore)
  window.webContents.on('did-finish-load', restore)
  window.once('closed', () => { if (pending) clearImmediate(pending) })
}
