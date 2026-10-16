/** Serializes repeated Quit/window-close requests and waits for teardown before allowing exit. */
export function createQuitController(options: {
  confirm: () => Promise<boolean>
  cleanup: () => Promise<void>
  commit: () => void
  cancel: (error?: unknown) => void
  canCommit?: () => boolean
}) {
  let ready = false
  let pending: Promise<void> | undefined
  return (event: { preventDefault: () => void }) => {
    if (ready && options.canCommit?.() !== false) return
    ready = false
    event.preventDefault()
    if (pending) return
    pending = (async () => {
      try {
        if (!await options.confirm()) { options.cancel(); return }
        await options.cleanup()
        ready = true
        options.commit()
      } catch (error) { options.cancel(error) }
      finally { pending = undefined }
    })()
  }
}
