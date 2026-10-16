import type { TerminalSnapshot } from '@shared/companion'

/** Reattach output polling to the same live terminal after a temporary bridge failure. */
export function pollWorkTerminal(options: {
  initial: TerminalSnapshot
  poll: (id: string, cursor: number) => Promise<TerminalSnapshot>
  accept: (snapshot: TerminalSnapshot) => Promise<void>
  onError: (error: unknown, terminalEnded: boolean) => void
}) {
  let current = options.initial
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    if (cancelled || (!current.running && !current.starting)) return
    let delay = 80
    try {
      const next = await options.poll(current.id, current.cursor)
      if (cancelled) return
      await options.accept(next)
      current = next
    } catch (error) {
      if (cancelled) return
      // Electron prefixes IPC errors, but both native engines retain this explicit message.
      const terminalEnded = /Terminal is no longer active/.test(error instanceof Error ? error.message : String(error))
      options.onError(error, terminalEnded)
      if (terminalEnded) return
      delay = 1500
    }
    if (!cancelled && (current.running || current.starting)) timer = setTimeout(() => void poll(), delay)
  }
  void poll()
  return () => { cancelled = true; clearTimeout(timer) }
}
