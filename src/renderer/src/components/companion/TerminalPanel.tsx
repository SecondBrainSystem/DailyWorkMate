import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ChevronDown, FolderOpen, LoaderCircle, Plus, RotateCw, Settings2, Terminal as TerminalIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { forwardImeSpaces } from '@/lib/terminalInput'
import { folderLabel } from '@/lib/folderLabel'
import type { TerminalCreateInput, TerminalSession, TerminalState, ShellKind } from '@shared/terminal'
import type { WorkspaceGrant } from '@shared/companion'
import '@xterm/xterm/css/xterm.css'

const names: Record<ShellKind, string> = { powershell: 'PowerShell', cmd: 'CMD', wsl: 'WSL', opencode: 'OpenCode' }
const badges: Record<ShellKind, string> = { powershell: 'PS', cmd: 'CMD', wsl: 'WSL', opencode: 'OC' }
const OPTIONS_KEY = 'dailyworkmate.terminal.optionsOpen'
const readOptionsOpen = () => { try { return localStorage.getItem(OPTIONS_KEY) === 'true' } catch { return false } }
function TerminalView({ session, visible, chinese, screenReaderMode, fresh, onAttached, onSession }: {
  session: TerminalSession; visible: boolean; chinese: boolean; screenReaderMode: boolean; fresh: boolean; onAttached: () => void; onSession: (session: TerminalSession) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const resize = useRef<() => void>(() => {})
  const callbacks = useRef({ onSession, onAttached, visible }); callbacks.current = { onSession, onAttached, visible }
  const [error, setError] = useState('')
  useEffect(() => {
    if (!host.current) return
    const api = window.electronAPI.terminal
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace', fontSize: 14, lineHeight: 1.15,
      scrollback: 5000, screenReaderMode, theme: { background: '#16181d', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#675174' } })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current)
    const spaces = forwardImeSpaces(terminal)
    let cancelled = false, cursor = 0, running = session.status === 'running', timer: ReturnType<typeof setTimeout> | undefined
    let first = true, replaying = !fresh
    let writes: Promise<unknown> = Promise.resolve()
    setError('')
    const report = (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) }
    resize.current = () => {
      if (cancelled || !host.current?.clientWidth || !host.current.clientHeight) return
      fit.fit()
      if (running) void api.resize(session.id, terminal.cols, terminal.rows).catch(report)
    }
    const observer = new ResizeObserver(() => resize.current()); observer.observe(host.current)
    const data = terminal.onData(value => {
      // Replaying saved output must not send old terminal-probe answers into today's shell prompt.
      if (!running || cancelled || replaying) return
      writes = writes.then(async () => { for (let offset = 0; offset < value.length && !cancelled; offset += 32768) await api.write(session.id, value.slice(offset, offset + 32768)) }).catch(report)
    })
    const poll = async () => {
      if (cancelled) return
      try {
        const next = await api.poll(session.id, cursor)
        if (cancelled) return
        if (next.reset) terminal.reset()
        if (next.data) await new Promise<void>(resolve => terminal.write(next.data, resolve))
        if (first) { first = false; replaying = false; callbacks.current.onAttached() }
        cursor = next.cursor; running = next.session.status === 'running'; callbacks.current.onSession(next.session)
        if (!cancelled) timer = setTimeout(() => void poll(), callbacks.current.visible ? 100 : 800)
      } catch (reason) { report(reason); if (!cancelled) timer = setTimeout(() => void poll(), 1500) }
    }
    resize.current(); terminal.focus(); void poll()
    return () => { cancelled = true; clearTimeout(timer); observer.disconnect(); spaces.dispose(); data.dispose(); terminal.dispose() }
  }, [session.id, session.createdAt, screenReaderMode])
  useEffect(() => { if (visible) requestAnimationFrame(() => resize.current()) }, [visible])
  return <div className="unified-terminal-view" role="tabpanel" id={'terminal-panel-' + session.id} aria-labelledby={'terminal-tab-' + session.id}>
    <div ref={host} className="unified-terminal-host" />
    {(error || session.error) && <p className="companion-terminal-error" role="alert">{error || session.error}</p>}
    <div className="unified-terminal-footer"><span role="status">{session.status === 'running' ? chinese ? '运行中' : 'Running' : session.status === 'starting' ? chinese ? '正在启动…' : 'Starting…' : chinese ? '已结束' : 'Ended'}</span><button type="button" className="terminal-open-folder" title={session.directory} aria-label={chinese ? '打开终端当前文件夹' : 'Open current terminal folder'} onClick={() => { void window.electronAPI.companion.openTerminalDirectory(session.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }}><FolderOpen size={14} /><span>{session.directory}</span></button></div>
  </div>
}

export function TerminalPanel({ chinese, visible, workspaces, model, prepareOpenCode, onOpenWork, createdTerminalId, screenReaderMode = false }: {
  chinese: boolean; visible: boolean; workspaces: WorkspaceGrant[]; model: string; prepareOpenCode: () => Promise<void>; onOpenWork?: () => void; createdTerminalId?: string; screenReaderMode?: boolean
}) {
  const api = window.electronAPI?.terminal
  const [state, setState] = useState<TerminalState | null>(null)
  const [kind, setKind] = useState<ShellKind>('powershell')
  const [directory, setDirectory] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  // Startup/exit options are rarely changed, so they stay folded away unless opened.
  const [optionsOpen, setOptionsOpen] = useState(readOptionsOpen)
  const mounted = useRef(true)
  const refreshing = useRef(false)
  const operation = useRef(false)
  const accepted = useRef<TerminalState | null>(null)
  const freshTerminal = useRef('')
  useEffect(() => {
    if (!createdTerminalId || !api) return
    freshTerminal.current = createdTerminalId
    setCreating(false)
    void api.get().then(accept).catch(report)
  }, [createdTerminalId, api])
  const accept = (next: TerminalState) => { if (mounted.current) { accepted.current = next; setState(next) } }
  const report = (reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  useEffect(() => {
    mounted.current = true
    if (!api) { setError(chinese ? '终端接口不可用，请重启桌面软件。' : 'The terminal bridge is unavailable. Restart the desktop application.'); return }
    void api.get().then(accept).catch(report)
    return () => { mounted.current = false }
  }, [api])
  useEffect(() => {
    if (!directory && (workspaces[0] || state?.defaultDirectory)) setDirectory(workspaces[0]?.path || state!.defaultDirectory)
    if (!workspaces.some(folder => folder.id === workspaceId)) setWorkspaceId(workspaces[0]?.id || '')
  }, [workspaces, workspaceId, directory, state?.defaultDirectory])
  useEffect(() => {
    if (!visible || !api) return
    const refresh = () => {
      if (refreshing.current || operation.current) return
      refreshing.current = true
      void api.get().then(accept).catch(report).finally(() => { refreshing.current = false })
    }
    refresh(); const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [visible, api])
  const perform = async (work: () => Promise<TerminalState>) => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { accept(await work()) } catch (reason) { report(reason) }
    finally { operation.current = false; if (mounted.current) setBusy(false) }
  }
  const create = async () => {
    if (kind === 'opencode' && onOpenWork) { onOpenWork(); setCreating(false); return }
    const folder = workspaces.find(item => item.id === workspaceId)
    const input: TerminalCreateInput = { id: crypto.randomUUID(), kind, directory: kind === 'opencode' ? folder?.path || '' : directory.trim(), cols: 100, rows: 30,
      ...(kind === 'opencode' ? { opencode: { workspaceId, model, accessScope: 'group', groupId: '' } } : {}) }
    await perform(async () => { if (kind === 'opencode') await prepareOpenCode(); const next = await api.create(input); freshTerminal.current = input.id; if (mounted.current) setCreating(false); return next })
  }
  const active = state?.sessions.find(session => session.id === state.activeId)
  const updateSession = (session: TerminalSession) => {
    const current = accepted.current
    if (!current) return
    const previous = current.sessions.find(item => item.id === session.id)
    if (previous && (previous.status !== session.status || previous.error !== session.error || previous.directory !== session.directory)) accept({ ...current, sessions: current.sessions.map(item => item.id === session.id ? session : item) })
  }
  const select = (id: string) => { void perform(() => api.select(id)) }
  const available = state?.shells.find(shell => shell.kind === kind)
  const showForm = creating || state?.sessions.length === 0
  return <section className="unified-terminal" aria-label={chinese ? '统一终端面板' : 'Unified terminal panel'}>
    <div className="unified-terminal-options">
      <button type="button" className="unified-terminal-options-toggle" aria-expanded={optionsOpen} aria-controls="terminal-options" onClick={() => setOptionsOpen(value => { try { localStorage.setItem(OPTIONS_KEY, String(!value)) } catch { /* per-viewer convenience only */ } return !value })}>
        <Settings2 size={14} /><span>{chinese ? '终端选项' : 'Terminal options'}</span>
        <small>{chinese ? '启动时恢复' : 'Restore on startup'}: {(state?.preferences.restoreOnStartup ?? true) ? chinese ? '开' : 'On' : chinese ? '关' : 'Off'} · {chinese ? '退出后保持运行' : 'Keep running after exit'}: {(state?.preferences.keepRunningOnExit ?? false) ? chinese ? '开' : 'On' : chinese ? '关' : 'Off'}</small>
        <ChevronDown size={14} className={'ml-auto transition-transform' + (optionsOpen ? ' rotate-180' : '')} />
      </button>
      {optionsOpen && <div className="unified-terminal-preferences" id="terminal-options">
        <label><input type="checkbox" role="switch" aria-label={chinese ? '启动时恢复未关闭终端' : 'Restore open terminals on startup'} checked={state?.preferences.restoreOnStartup ?? true} disabled={!state || busy} onChange={event => { void perform(() => api.savePreferences({ ...state!.preferences, restoreOnStartup: event.target.checked })) }} /><span>{chinese ? '启动时恢复未关闭终端' : 'Restore open terminals on startup'}<small>{chinese ? '保留标签、目录和最近输出' : 'Keep tabs, directories and recent output'}</small></span></label>
        <label><input type="checkbox" role="switch" aria-label={chinese ? '退出软件后保持终端运行' : 'Keep terminals running after exit'} checked={state?.preferences.keepRunningOnExit ?? false} disabled={!state || busy} onChange={event => { void perform(() => api.savePreferences({ ...state!.preferences, keepRunningOnExit: event.target.checked })) }} /><span>{chinese ? '退出软件后保持终端运行' : 'Keep terminals running after exit'}<small>{chinese ? '在后台继续任务，重新打开后接回' : 'Continue tasks in the background and reconnect'}</small></span></label>
      </div>}
    </div>
    <div className="unified-terminal-tabs">
      <div role="tablist" aria-label={chinese ? '终端标签' : 'Terminal tabs'}>{state?.sessions.map((session, index) => <div className={'unified-terminal-tab' + (session.id === active?.id ? ' is-active' : '')} key={session.id}>
        <button type="button" role="tab" id={'terminal-tab-' + session.id} aria-controls={'terminal-panel-' + session.id} aria-selected={session.id === active?.id} tabIndex={session.id === active?.id ? 0 : -1} disabled={busy} onClick={() => select(session.id)} onKeyDown={event => {
          if (!state || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.sessions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.sessions.length) % state.sessions.length
          select(state.sessions[next].id); document.getElementById('terminal-tab-' + state.sessions[next].id)?.focus()
        }} title={session.title + ' · ' + session.directory}><TerminalIcon size={14} /><span className="terminal-task">{folderLabel(session.directory) || session.title}</span><span className="terminal-kind">{badges[session.kind]}</span><i className={'terminal-dot ' + session.status} aria-hidden="true" /></button>
        <button type="button" className="terminal-close" aria-label={(chinese ? '关闭终端 ' : 'Close terminal ') + session.title} title={chinese ? '关闭并结束此终端' : 'Close and end this terminal'} disabled={busy} onClick={() => { if (session.status === 'running' && !window.confirm(chinese ? '关闭终端会结束任务，继续？' : 'Closing this terminal ends its task. Continue?')) return; void perform(() => api.close(session.id)) }}><X size={13} /></button>
      </div>)}</div>
      <Button variant="ghost" size="sm" aria-label={chinese ? '新建终端' : 'New terminal'} disabled={busy || !state || state.sessions.length >= 16} onClick={() => setCreating(value => !value)}><Plus size={15} />{chinese ? '新建' : 'New'}</Button>
      {active && <Button variant="ghost" size="sm" disabled={busy || active.status === 'starting' || active.status === 'running'} onClick={() => { void perform(async () => { const next = await api.restart(active.id); freshTerminal.current = active.id; if (mounted.current) setRevision(value => value + 1); return next }) }}><RotateCw size={14} />{chinese ? '重新连接' : 'Reconnect'}</Button>}
    </div>
    {showForm && <div className="unified-terminal-create">
      <label>{chinese ? '终端类型' : 'Shell'}<select aria-label={chinese ? '终端类型' : 'Shell'} value={kind} disabled={busy} onChange={event => setKind(event.target.value as ShellKind)}>{(['powershell', 'cmd', 'wsl', 'opencode'] as const).map(item => <option key={item} value={item} disabled={!state?.shells.find(shell => shell.kind === item)?.available}>{names[item]}</option>)}</select></label>
      {kind === 'opencode' ? <label className="terminal-directory-field">{chinese ? '授权工作目录' : 'Authorized folder'}<select aria-label={chinese ? '终端授权目录' : 'Terminal authorized folder'} value={workspaceId} disabled={busy} onChange={event => setWorkspaceId(event.target.value)}><option value="">{chinese ? '选择授权目录' : 'Choose an authorized folder'}</option>{workspaces.map(folder => <option key={folder.id} value={folder.id}>{folder.name} · {folder.writable ? chinese ? '可编辑' : 'Writable' : chinese ? '只读' : 'Read only'}</option>)}</select></label>
        : <label className="terminal-directory-field">{chinese ? '工作目录' : 'Working directory'}<div><input aria-label={chinese ? '终端工作目录' : 'Terminal working directory'} value={directory} disabled={busy} placeholder="C:\\Projects" onChange={event => setDirectory(event.target.value)} /><button type="button" aria-label={chinese ? '选择终端目录' : 'Choose terminal directory'} disabled={busy} onClick={() => { void api.pickDirectory().then(selected => { if (selected && mounted.current) setDirectory(selected) }).catch(report) }}><FolderOpen size={17} /></button></div></label>}
      <Button disabled={busy || !available?.available || (kind === 'opencode' ? !onOpenWork && (!workspaceId || !model) : !directory.trim())} onClick={() => { void create() }}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} />}{chinese ? '打开终端' : 'Open terminal'}</Button>
      {creating && !!state?.sessions.length && <Button variant="ghost" disabled={busy} onClick={() => setCreating(false)}>{chinese ? '取消' : 'Cancel'}</Button>}
      {kind === 'opencode' && !model && <p>{chinese ? '在上方选择模型后打开 OpenCode。' : 'Select a model above to open OpenCode.'}</p>}
      {available && !available.available && <p role="status">{kind === 'wsl' && chinese ? '请先安装 WSL 和 Linux 发行版。' : kind === 'opencode' && chinese ? '请先安装 OpenCode v2 并添加授权文件夹。' : available.reason}</p>}
    </div>}
    {error && <p className="companion-terminal-error" role="alert">{error}</p>}
    {!state && !error && <div className="terminal-empty" role="status"><LoaderCircle size={22} className="animate-spin" />{chinese ? '正在恢复终端…' : 'Restoring terminals…'}</div>}
    {active ? <TerminalView key={active.id + ':' + revision} session={active} visible={visible} chinese={chinese} screenReaderMode={screenReaderMode} fresh={freshTerminal.current === active.id} onAttached={() => { if (freshTerminal.current === active.id) freshTerminal.current = '' }} onSession={updateSession} />
      : state && <div className="terminal-empty"><TerminalIcon size={32} /><h2>{chinese ? '从这里继续工作' : 'Continue your work here'}</h2></div>}
  </section>
}
