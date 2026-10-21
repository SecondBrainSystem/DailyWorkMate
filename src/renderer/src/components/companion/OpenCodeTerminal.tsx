import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LoaderCircle, RefreshCcw, RotateCw, ShieldCheck } from 'lucide-react'
import { ErrorText } from '@/components/ui/error-text'
import { Button } from '@/components/ui/button'
import { observeTerminalLayout } from '@/lib/terminalLayout'
import { trackActivity, type ActivityState } from '@/lib/terminalActivity'
import { enableShiftWheelScroll, fittedSize, redrawTerminal, settledPtyResize, followScrollback, terminalOptions, writeInChunks } from '@/lib/terminalDisplay'
import { forwardImeSpaces } from '@/lib/terminalInput'
import { enableTerminalCopy } from '@/lib/terminalClipboard'
import { pollWorkTerminal } from '@/lib/terminalPolling'
import type { AgentEngine, TerminalInput, TerminalSnapshot } from '@shared/companion'
import '@xterm/xterm/css/xterm.css'

export type TerminalPhase = 'starting' | 'running' | 'recovering' | 'disconnected' | 'closed' | 'error'

/** One native OpenCode or Claude Code TUI. It connects on mount and disconnects on unmount (closing its tab). */
export function OpenCodeTerminal({ input, prepare, onSession, onPhase, onActivity, screenReaderMode = false, hidden = false, details, engine }: {
  input: Omit<TerminalInput, 'cols' | 'rows'>
  prepare: () => Promise<void>; onSession: (id: string) => void
  /** Reports connection state, e.g. for the tab's status dot. */
  onPhase?: (phase: TerminalPhase) => void
  /** Whether the TUI is working on a turn, finished one the user has not typed after yet, or idle. */
  onActivity?: (state: ActivityState) => void
  screenReaderMode?: boolean
  /** Inactive Work tabs stay connected but are not shown. */
  hidden?: boolean
  /** Session facts shown in the toolbar: folder, permission, model. */
  details?: ReactNode
  engine?: AgentEngine
}) {
  const host = useRef<HTMLDivElement>(null)
  const display = useRef<Terminal | null>(null)
  const reconnect = useRef<() => Promise<void>>(async () => {})
  const redraw = useRef<() => void>(() => {})
  const callbacks = useRef({ prepare, onSession, onPhase, onActivity, hidden })
  callbacks.current = { prepare, onSession, onPhase, onActivity, hidden }
  // i18n.t reads the language when a notice is shown: a language switch must not restart the terminal.
  const { t, i18n } = useTranslation()
  const [phase, setPhase] = useState<TerminalPhase>('starting')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [stage, setStage] = useState('verify')
  const [restart, setRestart] = useState(0)
  const [canReconnect, setCanReconnect] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  // A saved native ID is returned during startup. Updating it must not restart the same terminal.
  const initial = useRef(input)
  initial.current = input
  const scope = JSON.stringify({ workspace: input.workspaceId, group: input.groupId, access: input.accessScope,
    folder: input.relativePath, model: input.model })
  useEffect(() => { callbacks.current.onPhase?.(phase) }, [phase])
  useEffect(() => { if (display.current) display.current.options.screenReaderMode = screenReaderMode }, [screenReaderMode])
  // Returning to a Work tab must put the caret back in its TUI; otherwise focus stays on the tab
  // button, typing goes nowhere and Enter clicks the tab again. Hiding releases the IME first.
  useEffect(() => {
    const terminal = display.current
    if (!terminal) return
    if (hidden) { if (terminal.textarea && terminal.textarea === document.activeElement) terminal.blur(); return }
    const frame = requestAnimationFrame(() => terminal.focus())
    return () => cancelAnimationFrame(frame)
  }, [hidden])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!host.current) return
    const api = window.electronAPI.companion
    const requestId = crypto.randomUUID()
    const terminal = new Terminal(terminalOptions(screenReaderMode, { convertEol: false }))
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    display.current = terminal
    const spaces = forwardImeSpaces(terminal)
    const stopCopy = enableTerminalCopy(terminal, host.current, reason => setError(String(reason)))
    const stopShiftWheel = enableShiftWheelScroll(terminal, host.current), stopScrollback = followScrollback(terminal)
    let cancelled = false, remote: TerminalSnapshot | undefined
    // The TUI runs directly (no shell prompt), so only its own working signals count; output restored on
    // attach is history, not new activity. See terminalActivity.
    let attached = false
    const tracker = trackActivity(terminal, { shellPrompts: false, ignore: () => !attached || cancelled, onChange: state => callbacks.current.onActivity?.(state) })
    let requested = false
    let closing: Promise<void> | undefined
    const close = () => {
      if (!closing) closing = api.closeTerminal(requestId).catch(reason => { closing = undefined; throw reason })
      return closing
    }
    let stopPolling = () => {}
    let writing: Promise<void> = Promise.resolve()
    setPhase('starting'); setError(''); setCanReconnect(false); setReconnecting(false)
    const report = (reason: unknown, terminalEnded = false) => {
      if (cancelled) return
      if (terminalEnded) remote = undefined
      if (terminalEnded) setCanReconnect(false)
      setError(reason instanceof Error ? reason.message : String(reason)); setPhase(remote?.running || remote?.starting ? 'recovering' : remote?.canReconnect ? 'disconnected' : 'error')
    }
    const ptySize = settledPtyResize((cols, rows) => { if (remote?.running && !cancelled) void api.resizeTerminal(remote.id, cols, rows).catch(report) })
    const resize = () => {
      const size = cancelled ? undefined : fittedSize(host.current, fit)
      if (!size) return
      terminal.resize(size.cols, size.rows)
      if (remote?.running) ptySize.request(terminal.cols, terminal.rows)
    }
    redraw.current = () => {
      const id = remote?.running && !cancelled ? remote.id : ''
      if (!id) return
      void redrawTerminal(terminal, (cols, rows) => api.resizeTerminal(id, cols, rows)).catch(report)
      terminal.focus()
    }
    const stopLayout = observeTerminalLayout(host.current, resize)
    resize()
    const accept = async (next: TerminalSnapshot) => {
      if (cancelled) return
      const sessionChanged = !!next.sessionId && next.sessionId !== remote?.sessionId
      remote = next
      setCanReconnect(!!next.canReconnect)
      if (sessionChanged) callbacks.current.onSession(next.sessionId)
      if (next.accessChanged) {
        // Revocation must stop the old task. Loading its transcript cannot resume that process.
        if (!cancelled) { setNotice(i18n.t('terminal.work.accessChanged')); setError(''); setPhase('closed') }
        return
      }
      if (next.reset) terminal.reset()
      if (next.data) await new Promise<void>(resolve => terminal.write(next.data, resolve))
      if (next.data) tracker.output()
      attached = true
      if (!next.running && !next.starting) tracker.ended()
      if (cancelled) return
      if (next.error) report(next.error)
      else { setError(''); setPhase(next.starting ? 'starting' : next.running ? 'running' : next.canReconnect ? 'disconnected' : 'closed') }
    }
    const data = terminal.onData(value => {
      if (!remote?.running || cancelled) return
      tracker.input(value)
      // Preserve keystroke order, including terminal device responses and pasted Unicode.
      const id = remote.id
      writing = writing.then(() => writeInChunks(value, chunk => api.writeTerminal(id, chunk), () => cancelled)).catch(report)
    })
    const beginPolling = (next: TerminalSnapshot) => {
      stopPolling()
      stopPolling = pollWorkTerminal({ initial: next, poll: api.pollTerminal, accept, onError: report, interval: () => callbacks.current.hidden ? 600 : 80 })
    }
    let retrying = false
    reconnect.current = async () => {
      if (cancelled || retrying) return
      retrying = true; setReconnecting(true); setError('')
      const restartRequested = !remote?.canReconnect
      const startAgain = async () => {
        // Release the old server attachment before opening a replacement. Otherwise a
        // late close can cancel a new preparation that reused the same server/database.
        await close()
        if (!cancelled) setRestart(value => value + 1)
      }
      try {
        // Check the original process before ever offering to replace it.
        stopPolling()
        if (!requested) { await startAgain(); return }
        const next = await api.pollTerminal(remote?.id || requestId, remote?.cursor || 0)
        if (cancelled) return
        if (next.starting || next.running) { await accept(next); beginPolling(next); return }
        if (next.canReconnect) {
          const attached = await api.reconnectTerminal(next.id, terminal.cols, terminal.rows)
          if (cancelled) return
          await accept(attached); beginPolling(attached); if (!callbacks.current.hidden) terminal.focus()
        } else {
          await accept(next)
          // If a Reattach action became stale, first show the ended state. Only an
          // explicit Start again action can replace a confirmed ended process.
          if (restartRequested) await startAgain()
        }
      } catch (reason) {
        if (cancelled) return
        const terminalEnded = /Terminal is no longer active/.test(reason instanceof Error ? reason.message : String(reason))
        if (!cancelled && remote) {
          try { await accept(await api.pollTerminal(remote.id, remote.cursor)) }
          catch (refreshError) { console.error('[Companion] Refresh disconnected terminal:', refreshError) }
        }
        if (cancelled) return
        report(reason, terminalEnded)
        if (terminalEnded && restartRequested) {
          try { await startAgain() } catch (closeError) { report(closeError) }
        }
        else if (remote && (remote.running || remote.starting)) beginPolling(remote)
      } finally { retrying = false; if (!cancelled) setReconnecting(false) }
    }
    void (async () => {
      if (cancelled) return
      setStage('verify')
      await callbacks.current.prepare()
      setStage('start')
      if (cancelled) return
      resize()
      requested = true
      const next = await api.openTerminal({ ...initial.current, terminalId: requestId, cols: terminal.cols, rows: terminal.rows })
      if (cancelled) { await api.closeTerminal(next.id); return }
      await accept(next)
      if (cancelled) return
      resize(); if (!callbacks.current.hidden) terminal.focus()
      beginPolling(next)
    })().catch(report)
    const stop = () => {
      cancelled = true; stopPolling()
      void close().catch(reason => console.error('[Companion] Close terminal:', reason))
    }
    return () => {
      stop(); tracker.dispose(); callbacks.current.onActivity?.('idle'); ptySize.cancel(); stopLayout(); stopShiftWheel(); stopScrollback(); stopCopy(); spaces.dispose(); data.dispose(); if (display.current === terminal) display.current = null
      // End any IME composition while the textarea is still attached; see TerminalPanel.
      if (terminal.textarea && terminal.textarea === document.activeElement) terminal.blur()
      terminal.dispose()
    }
  }, [scope, restart])

  const ended = phase === 'closed' || phase === 'error' || phase === 'disconnected'
  return <section className="companion-terminal" hidden={hidden} aria-label={t('terminal.work.label', { engine: engine === 'claude' ? 'Claude Code' : 'OpenCode v2' })}>
    <div className="companion-terminal-toolbar">{details}
      <span className="companion-terminal-state" role="status" data-phase={phase}>{phase === 'starting' ? t('terminal.work.phase.starting') : phase === 'running' ? t('terminal.work.phase.running') : phase === 'recovering' ? t('terminal.work.phase.recovering') : canReconnect ? t('terminal.work.phase.disconnected') : phase === 'closed' ? t('terminal.work.phase.closed') : t('terminal.work.phase.failed')}</span>
      {phase === 'running' && <Button size="sm" variant="ghost" className="terminal-redraw" title={t('terminal.redrawTitle')} onClick={() => redraw.current()}><RefreshCcw size={13} className="mr-1" />{t('terminal.redraw')}</Button>}
      {ended && <Button size="sm" variant="ghost" disabled={reconnecting} onClick={() => void reconnect.current()}>{reconnecting ? <LoaderCircle size={13} className="mr-1 animate-spin" /> : <RotateCw size={13} className="mr-1" />}{reconnecting ? canReconnect ? t('terminal.work.reattaching') : t('terminal.work.restarting') : canReconnect ? t('terminal.work.reattach') : t('terminal.work.startAgain')}</Button>}
    </div>
    {notice && <p className="companion-terminal-notice" role="status"><ShieldCheck size={14} />{notice}</p>}
    {phase === 'recovering' && <p className="companion-terminal-notice" role="status"><LoaderCircle size={14} className="animate-spin" />{t('terminal.work.recoveringNotice')}</p>}
    {ended && <p className="companion-terminal-notice" role="status">{canReconnect ? t('terminal.work.reattachHint') : t('terminal.work.restartHint')}</p>}
    <div ref={host} className="companion-terminal-host" title={t('terminal.copyHint')} />
    {phase === 'starting' && <div className="companion-terminal-loading" role="status"><LoaderCircle size={18} className="animate-spin" />{stage === 'verify' ? t('terminal.work.verifying') : t('terminal.work.starting')}
</div>}
    {error && <p className="companion-terminal-error" role="alert"><ErrorText error={error} /></p>}
  </section>
}
