/**
 * Serializes repeated Quit/window-close requests. Everything that can still cancel the quit
 * (unsaved changes, psmux sessions) is asked in confirm, before any service stops; once confirmed
 * the quit always finishes, because cleanup cannot be undone.
 */
export function createQuitController(options: {
  confirm: () => Promise<boolean>
  /** The user confirmed: from here on the quit is committed. */
  begin?: () => void
  cleanup: () => Promise<void>
  /** Cleanup failed; the quit still finishes so the app never stays open with stopped services. */
  cleanupFailed?: (error: unknown) => void
  commit: () => void
  cancel: (error?: unknown) => void
  /** Ends the process if the committed quit is blocked elsewhere (e.g. a window refused to close). */
  exit?: () => void
  exitDelay?: number
}) {
  let committed = false
  let pending: Promise<void> | undefined
  return (event: { preventDefault: () => void }) => {
    if (committed) return
    event.preventDefault()
    if (pending) return
    pending = (async () => {
      try {
        if (!await options.confirm()) { options.cancel(); return }
      } catch (error) { options.cancel(error); return }
      options.begin?.()
      try { await options.cleanup() } catch (error) { options.cleanupFailed?.(error) }
      committed = true
      options.commit()
      if (options.exit) setTimeout(options.exit, options.exitDelay ?? 10000).unref?.()
    })().finally(() => { pending = undefined })
  }
}
