import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LoaderCircle, RotateCw, ShieldCheck } from 'lucide-react'
import { ErrorText } from '@/components/ui/error-text'
import { Button } from '@/components/ui/button'
import { observeTerminalLayout } from '@/lib/terminalLayout'
import { forwardImeSpaces } from '@/lib/terminalInput'
import { pollWorkTerminal } from '@/lib/terminalPolling'
import type { AgentEngine, TerminalInput, TerminalSnapshot } from '@shared/companion'
import '@xterm/xterm/css/xterm.css'

export type TerminalPhase = 'starting' | 'running' | 'recovering' | 'disconnected' | 'closed' | 'error'

/** One native OpenCode or Claude Code TUI. It connects on mount and disconnects on unmount (closing its tab). */
export function OpenCodeTerminal({ input, chinese, prepare, onSession, onPhase, screenReaderMode = false, hidden = false, details, engine }: {
  input: Omit<TerminalInput, 'cols' | 'rows'>; chinese: boolean
  prepare: () => Promise<void>; onSession: (id: string) => void
  /** Reports connection state, e.g. for the tab's status dot. */
  onPhase?: (phase: TerminalPhase) => void
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
  const callbacks = useRef({ prepare, onSession, onPhase })
  callbacks.current = { prepare, onSession, onPhase }
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
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!host.current) return
    const api = window.electronAPI.companion
    const requestId = crypto.randomUUID()
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: 14, lineHeight: 1.15, scrollback: 5000, convertEol: false, screenReaderMode,
      theme: { background: '#16181d', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#675174' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    display.current = terminal
    const spaces = forwardImeSpaces(terminal)
    let cancelled = false, remote: TerminalSnapshot | undefined
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
    const resize = () => {
      if (cancelled || !host.current?.clientWidth || !host.current.clientHeight) return
      const size = fit.proposeDimensions()
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols < 2 || size.rows < 2) return
      terminal.resize(Math.min(size.cols, 500), Math.min(size.rows, 250))
      if (remote?.running) void api.resizeTerminal(remote.id, terminal.cols, terminal.rows).catch(report)
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
        if (!cancelled) { setNotice(chinese ? '文件夹权限已改变，原终端已停止。重新启动可使用新权限，先前任务不会自动继续。' : 'Folder permissions changed and the original terminal stopped. Start it again to use the new permissions; the previous task will not resume automatically.'); setError(''); setPhase('closed') }
        return
      }
      if (next.reset) terminal.reset()
      if (next.data) await new Promise<void>(resolve => terminal.write(next.data, resolve))
      if (cancelled) return
      if (next.error) report(next.error)
      else { setError(''); setPhase(next.starting ? 'starting' : next.running ? 'running' : next.canReconnect ? 'disconnected' : 'closed') }
    }
    const data = terminal.onData(value => {
      if (!remote?.running || cancelled) return
      // Preserve keystroke order, including terminal device responses and pasted Unicode.
      const id = remote.id
      writing = writing.then(async () => {
        if (cancelled) return
        for (let offset = 0; offset < value.length; offset += 32768) await api.writeTerminal(id, value.slice(offset, offset + 32768))
      }).catch(report)
    })
    const beginPolling = (next: TerminalSnapshot) => {
      stopPolling()
      stopPolling = pollWorkTerminal({ initial: next, poll: api.pollTerminal, accept, onError: report })
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
          await accept(attached); beginPolling(attached); terminal.focus()
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
      resize(); terminal.focus()
      beginPolling(next)
    })().catch(report)
    const stop = () => {
      cancelled = true; stopPolling()
      void close().catch(reason => console.error('[Companion] Close terminal:', reason))
    }
    return () => { stop(); stopLayout(); spaces.dispose(); data.dispose(); if (display.current === terminal) display.current = null; terminal.dispose() }
  }, [scope, restart])

  const ended = phase === 'closed' || phase === 'error' || phase === 'disconnected'
  return <section className="companion-terminal" hidden={hidden} aria-label={(engine === 'claude' ? 'Claude Code' : 'OpenCode v2') + (chinese ? ' 工作终端' : ' work terminal')}>
    <div className="companion-terminal-toolbar">{details}
      <span className="companion-terminal-state" role="status" data-phase={phase}>{phase === 'starting' ? chinese ? '正在连接…' : 'Connecting…' : phase === 'running' ? chinese ? '已连接' : 'Connected' : phase === 'recovering' ? chinese ? '正在恢复连接…' : 'Recovering connection…' : canReconnect ? chinese ? '终端显示已断开' : 'Terminal display disconnected' : phase === 'closed' ? chinese ? '终端已结束' : 'Terminal ended' : chinese ? '连接失败' : 'Connection failed'}</span>
      {ended && <Button size="sm" variant="ghost" disabled={reconnecting} onClick={() => void reconnect.current()}>{reconnecting ? <LoaderCircle size={13} className="mr-1 animate-spin" /> : <RotateCw size={13} className="mr-1" />}{reconnecting ? canReconnect ? chinese ? '正在接回…' : 'Reattaching…' : chinese ? '正在重启…' : 'Restarting…' : canReconnect ? chinese ? '接回终端显示' : 'Reattach terminal' : chinese ? '重新启动终端' : 'Start terminal again'}</Button>}
    </div>
    {notice && <p className="companion-terminal-notice" role="status"><ShieldCheck size={14} />{notice}</p>}
    {phase === 'recovering' && <p className="companion-terminal-notice" role="status"><LoaderCircle size={14} className="animate-spin" />{chinese ? '终端显示暂时失去连接，正在自动接回原会话；后台任务可能仍在运行。' : 'The terminal view temporarily lost its connection. Reconnecting to the same session; its task may still be running.'}</p>}
    {ended && <p className="companion-terminal-notice" role="status">{canReconnect ? chinese ? '原工作服务仍在运行，接回显示不会重启工作服务。' : 'The original work service is still running. Reattaching its display will not restart that service.' : chinese ? '重新启动前会先检查原终端。如果它已停止，新进程只会恢复对话记录，不会继续先前的程序。' : 'The original terminal will be checked before restarting. If it has stopped, a new process can restore conversation history but cannot resume the previous program.'}</p>}
    <div ref={host} className="companion-terminal-host" />
    {phase === 'starting' && <div className="companion-terminal-loading" role="status"><LoaderCircle size={18} className="animate-spin" />{stage === 'verify' ? chinese ? '正在验证模型，可随时关闭会话取消…' : 'Verifying the model; close the session to cancel…' : chinese ? '正在启动终端并检查文件夹权限…' : 'Starting the terminal and checking folder permissions…'}</div>}
    {error && <p className="companion-terminal-error" role="alert"><ErrorText error={error} /></p>}
  </section>
}
