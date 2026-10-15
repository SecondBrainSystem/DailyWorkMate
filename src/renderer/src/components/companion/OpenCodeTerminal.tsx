import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LoaderCircle, RotateCw, ShieldCheck } from 'lucide-react'
import { ErrorText } from '@/components/ui/error-text'
import { Button } from '@/components/ui/button'
import { forwardImeSpaces } from '@/lib/terminalInput'
import type { AgentEngine, TerminalInput, TerminalSnapshot } from '@shared/companion'
import '@xterm/xterm/css/xterm.css'

export type TerminalPhase = 'starting' | 'running' | 'closed' | 'error'
// Opens wait until every previously closing tab has released its server.

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
  const callbacks = useRef({ prepare, onSession, onPhase })
  callbacks.current = { prepare, onSession, onPhase }
  const [phase, setPhase] = useState<TerminalPhase>('starting')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [stage, setStage] = useState('verify')
  const [restart, setRestart] = useState(0)
  // A saved native ID is returned during startup. Updating it must not restart the same terminal.
  const initial = useRef(input)
  initial.current = input
  const scope = JSON.stringify({ workspace: input.workspaceId, group: input.groupId, access: input.accessScope,
    folder: input.relativePath, model: input.model })
  useEffect(() => { callbacks.current.onPhase?.(phase) }, [phase])
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
    const spaces = forwardImeSpaces(terminal)
    let cancelled = false, remote: TerminalSnapshot | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let writing: Promise<void> = Promise.resolve()
    setPhase('starting'); setError('')
    const report = (reason: unknown) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : String(reason)); setPhase('error')
    }
    const resize = () => {
      if (cancelled || !host.current?.clientWidth || !host.current.clientHeight) return
      fit.fit()
      if (remote?.running) void api.resizeTerminal(remote.id, terminal.cols, terminal.rows).catch(report)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    resize()
    const accept = async (next: TerminalSnapshot) => {
      remote = next
      if (next.accessChanged) {
        // The main process ended this tab because its folder permissions changed; reopen under the new ones.
        if (!cancelled) { setNotice(chinese ? '文件夹权限已更新，正在按新权限重新连接…' : 'Folder permissions changed. Reconnecting with the new permissions…'); setRestart(value => value + 1) }
        return
      }
      if (next.reset) terminal.reset()
      if (next.data) await new Promise<void>(resolve => terminal.write(next.data, resolve))
      if (cancelled) return
      if (next.error) report(next.error)
      else setPhase(next.running ? 'running' : 'closed')
    }
    const poll = async () => {
      if (cancelled || !remote?.running) return
      try { await accept(await api.pollTerminal(remote.id, remote.cursor)) }
      catch (reason) { report(reason); return }
      if (!cancelled && remote.running) timer = setTimeout(() => void poll(), 80)
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
    void (async () => {
      if (cancelled) return
      setStage('verify')
      await callbacks.current.prepare()
      setStage('start')
      if (cancelled) return
      resize()
      const next = await api.openTerminal({ ...initial.current, terminalId: requestId, cols: terminal.cols, rows: terminal.rows })
      if (cancelled) { await api.closeTerminal(next.id); return }
      callbacks.current.onSession(next.sessionId)
      await accept(next)
      resize(); terminal.focus(); void poll()
    })().catch(report)
    const stop = () => {
      cancelled = true; clearTimeout(timer)
      const closing = api.closeTerminal(requestId).catch(reason => console.error('[Companion] Close terminal:', reason))
      void closing
    }
    return () => { stop(); observer.disconnect(); spaces.dispose(); data.dispose(); terminal.dispose() }
  }, [scope, restart, screenReaderMode])

  const ended = phase === 'closed' || phase === 'error'
  return <section className="companion-terminal" hidden={hidden} aria-label={(engine === 'claude' ? 'Claude Code' : 'OpenCode v2') + (chinese ? ' 工作终端' : ' work terminal')}>
    <div className="companion-terminal-toolbar">{details}
      <span className="companion-terminal-state" role="status" data-phase={phase}>{phase === 'starting' ? chinese ? '正在连接…' : 'Connecting…' : phase === 'running' ? chinese ? '已连接' : 'Connected' : chinese ? '已断开' : 'Disconnected'}</span>
      {ended && <Button size="sm" variant="ghost" onClick={() => setRestart(value => value + 1)}><RotateCw size={13} className="mr-1" />{chinese ? '重新连接' : 'Reconnect'}</Button>}
    </div>
    {notice && <p className="companion-terminal-notice" role="status"><ShieldCheck size={14} />{notice}</p>}
    <div ref={host} className="companion-terminal-host" />
    {phase === 'starting' && <div className="companion-terminal-loading" role="status"><LoaderCircle size={18} className="animate-spin" />{stage === 'verify' ? chinese ? '正在验证模型，可随时关闭会话取消…' : 'Verifying the model; close the session to cancel…' : chinese ? '正在启动终端并检查文件夹权限…' : 'Starting the terminal and checking folder permissions…'}</div>}
    {error && <p className="companion-terminal-error" role="alert"><ErrorText error={error} /></p>}
  </section>
}
