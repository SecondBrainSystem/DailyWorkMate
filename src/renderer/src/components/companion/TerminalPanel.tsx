import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createPortal } from 'react-dom'
import { Columns2, FolderOpen, LoaderCircle, Plus, RefreshCcw, RotateCw, Rows2, SlidersHorizontal, Terminal as TerminalIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { observeTerminalLayout } from '@/lib/terminalLayout'
import { combineActivity, trackActivity, type ActivityState } from '@/lib/terminalActivity'
import { ActivityMark } from './ActivityMark'
import { HeaderPopover } from './HeaderPopover'
import { enableShiftWheelScroll, fittedSize, redrawTerminal, settledPtyResize, followScrollback, readScrollback, saveScrollback, SCROLLBACK_CHOICES, terminalOptions, writeInChunks } from '@/lib/terminalDisplay'
import { forwardImeSpaces } from '@/lib/terminalInput'
import { folderLabel } from '@/lib/folderLabel'
import type { TerminalCreateInput, TerminalSession, TerminalState, ShellKind } from '@shared/terminal'
import { MAX_PANES, MAX_RATIO, MIN_RATIO, clampRatio, neighborPane, paneGeometry, panesOf, setRatio, tabOf, type PaneDirection, type PaneRect, type SplitDirection, type TerminalTab } from '@shared/terminalTabs'
import type { WorkspaceGrant } from '@shared/companion'
import '@xterm/xterm/css/xterm.css'

const names: Record<ShellKind, string> = { powershell: 'PowerShell', cmd: 'CMD', wsl: 'WSL', opencode: 'OpenCode' }
const badges: Record<ShellKind, string> = { powershell: 'PS', cmd: 'CMD', wsl: 'WSL', opencode: 'OC' }
const NARROW = '(max-width: 700px)'
const label = (session: TerminalSession) => folderLabel(session.directory) || session.title
// Panes are absolutely placed from the layout tree, so a split never re-parents (and remounts) a live xterm.
const GAP = 3
const placement = ({ x, y, w, h }: PaneRect): CSSProperties => {
  const inner = (start: number, size: number) => [start > 1e-6 ? GAP : 0, start + size < 1 - 1e-6 ? GAP : 0]
  const [left, right] = inner(x, w), [top, bottom] = inner(y, h)
  return { left: `calc(${x * 100}% + ${left}px)`, width: `calc(${w * 100}% - ${left + right}px)`, top: `calc(${y * 100}% + ${top}px)`, height: `calc(${h * 100}% - ${top + bottom}px)` }
}
// Every open terminal stays mounted; switching tabs only hides the inactive ones. Destroying the
// focused xterm textarea on each switch could leave the Windows IME detached (English only, Enter lost).
function TerminalView({ session, tabActive, focused, visible, split, activity, style, screenReaderMode, fresh, focusOnActivate, onAttached, onSession, onActivity, onFocusPane, onClosePane }: {
  session: TerminalSession; tabActive: boolean; focused: boolean; visible: boolean; split: boolean; activity: ActivityState; style: CSSProperties
  screenReaderMode: boolean; fresh: boolean; focusOnActivate: MutableRefObject<boolean>
  onAttached: () => void; onSession: (session: TerminalSession) => void; onActivity: (id: string, state: ActivityState) => void
  onFocusPane: (id: string, focusTerminal: boolean) => void; onClosePane: (session: TerminalSession) => void
}) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const display = useRef<Terminal | null>(null)
  const resize = useRef<() => void>(() => {})
  const redraw = useRef<() => void>(() => {})
  const pollNow = useRef<() => void>(() => {})
  const shown = tabActive && visible
  const callbacks = useRef({ onSession, onAttached, onActivity, shown, visible, focused }); callbacks.current = { onSession, onAttached, onActivity, shown, visible, focused }
  const [error, setError] = useState('')
  useEffect(() => {
    if (!host.current) return
    const api = window.electronAPI.terminal
    const terminal = new Terminal(terminalOptions(screenReaderMode, { cursorStyle: 'bar', cursorInactiveStyle: 'bar', cursorWidth: 1 }))
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current)
    display.current = terminal
    const spaces = forwardImeSpaces(terminal)
    const stopShiftWheel = enableShiftWheelScroll(terminal, host.current), stopScrollback = followScrollback(terminal)
    let cancelled = false, cursor = 0, running = session.status === 'running', timer: ReturnType<typeof setTimeout> | undefined, polling = false
    let first = true, replaying = !fresh
    let writes: Promise<unknown> = Promise.resolve()
    // Working / done / idle per pane: shells mark every prompt with OSC 7, and agent TUIs (Claude Code, Codex,
    // OpenCode) announce their own turns; see terminalActivity. Replayed history is not new activity.
    const tracker = trackActivity(terminal, { shellPrompts: session.kind !== 'opencode', ignore: () => replaying || cancelled,
      onChange: state => callbacks.current.onActivity(session.id, state) })
    const prompt = terminal.parser.registerOscHandler(7, () => { tracker.prompt(); return false })
    setError('')
    // A failed poll's banner clears on the next successful poll; other failures stay until replaced.
    let pollFailed = false
    const report = (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) }
    const ptySize = settledPtyResize((cols, rows) => { if (running && !cancelled) void api.resize(session.id, cols, rows).catch(report) })
    resize.current = () => {
      const size = cancelled ? undefined : fittedSize(host.current, fit)
      if (!size) return
      terminal.resize(size.cols, size.rows)
      if (running) ptySize.request(terminal.cols, terminal.rows)
    }
    redraw.current = () => {
      if (!running || cancelled) return
      void redrawTerminal(terminal, (cols, rows) => api.resize(session.id, cols, rows)).catch(report)
      terminal.focus()
    }
    const stopLayout = observeTerminalLayout(host.current, () => resize.current())
    const data = terminal.onData(value => {
      // Replaying saved output must not send old terminal-probe answers into today's shell prompt.
      if (!running || cancelled || replaying) return
      tracker.input(value)
      writes = writes.then(() => writeInChunks(value, chunk => api.write(session.id, chunk), () => cancelled)).catch(report)
    })
    const poll = async () => {
      if (cancelled) return
      polling = true
      try {
        const next = await api.poll(session.id, cursor)
        if (cancelled) return
        if (pollFailed) { pollFailed = false; setError('') }
        if (next.reset) terminal.reset()
        if (next.data) await new Promise<void>(resolve => terminal.write(next.data, resolve))
        if (cancelled) return
        if (next.data) tracker.output()
        if (first) { first = false; replaying = false; callbacks.current.onAttached() }
        // A shell that finished starting after the last layout change never received the fitted size.
        const started = !running && next.session.status === 'running'
        cursor = next.cursor; running = next.session.status === 'running'; callbacks.current.onSession(next.session)
        if (started) resize.current()
        if (!running) tracker.ended()
        // Background tabs keep their activity indicator; a hidden Terminal view only needs to keep up slowly.
        if (!cancelled) timer = setTimeout(() => void poll(), callbacks.current.shown ? 100 : callbacks.current.visible ? 800 : 2500)
      } catch (reason) { report(reason); pollFailed = !cancelled; if (!cancelled) timer = setTimeout(() => void poll(), 1500) }
      finally { polling = false }
    }
    // Showing the view again must not wait out a long background delay.
    pollNow.current = () => { if (!polling && !cancelled) { clearTimeout(timer); void poll() } }
    resize.current(); if (callbacks.current.shown && callbacks.current.focused) terminal.focus(); void poll()
    return () => {
      cancelled = true; clearTimeout(timer); tracker.dispose(); callbacks.current.onActivity(session.id, 'idle')
      ptySize.cancel(); stopLayout(); stopShiftWheel(); stopScrollback(); prompt.dispose(); spaces.dispose(); data.dispose()
      // Blur first so any open IME composition ends while its textarea is still in the document.
      if (terminal.textarea && terminal.textarea === document.activeElement) terminal.blur()
      if (display.current === terminal) display.current = null
      terminal.dispose()
    }
  }, [session.id, session.createdAt, screenReaderMode])
  useEffect(() => {
    const terminal = display.current
    if (!terminal) return
    // Only the focused pane of the active tab keeps the textarea (and the IME); release it everywhere else.
    if ((!focused || !tabActive) && terminal.textarea && terminal.textarea === document.activeElement) terminal.blur()
    if (!tabActive || !visible) return
    pollNow.current()
    const frame = requestAnimationFrame(() => {
      resize.current()
      if (focused && focusOnActivate.current) { focusOnActivate.current = false; terminal.focus() }
    })
    return () => cancelAnimationFrame(frame)
  }, [tabActive, focused, visible])
  const name = label(session)
  return <div className={'terminal-pane' + (split && focused ? ' is-focused' : '')} style={style} role="group" aria-label={t('terminal.pane.label', { name })} data-terminal-id={session.id}
    onFocusCapture={() => { if (!focused) onFocusPane(session.id, false) }}
    onMouseDown={event => {
      if ((event.target as Element).closest('button')) return
      if (focused) requestAnimationFrame(() => display.current?.focus()); else onFocusPane(session.id, true)
    }}>
    {split && <div className="terminal-pane-header">
      <span className="terminal-kind">{badges[session.kind]}</span><span className="terminal-pane-title" title={session.directory}>{name}</span>
      <ActivityMark state={activity} idle={<i className={'terminal-dot ' + session.status} aria-hidden="true" />} />
      <button type="button" className="terminal-pane-close" aria-label={t('terminal.pane.close', { name })} title={t('terminal.pane.closeTitle')} onClick={() => onClosePane(session)}><X size={12} /></button>
    </div>}
    <div ref={host} className="unified-terminal-host" />
    {(error || session.error) && <p className="companion-terminal-error" role="alert">{error || session.error}</p>}
    <div className="unified-terminal-footer"><span role="status">{session.status === 'running' ? t('terminal.status.running') : session.status === 'starting' ? t('terminal.status.starting') : t('terminal.status.ended')}</span>
      {session.status === 'running' && <button type="button" className="terminal-redraw" title={t('terminal.redrawTitle')} aria-label={t('terminal.redrawLabel', { name })} onClick={() => redraw.current()}><RefreshCcw size={12} /><span>{t('terminal.redraw')}</span></button>}<button type="button" className="terminal-open-folder" title={session.directory} aria-label={t('terminal.openFolder')} onClick={() => { void window.electronAPI.companion.openTerminalDirectory(session.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }}><FolderOpen size={14} /><span>{session.directory}</span></button></div>
  </div>
}

/** Drag with a pointer, or focus and use the arrow keys (Home/End for the limits). */
function PaneDivider({ path, split, ratio, area, container, onChange, onCommit }: {
  path: string; split: SplitDirection; ratio: number; area: PaneRect; container: () => HTMLDivElement | null | undefined
  onChange: (path: string, ratio: number) => void; onCommit: () => void
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const row = split === 'row'
  const at = row ? area.x + area.w * ratio : area.y + area.h * ratio
  const style: CSSProperties = row ? { left: `calc(${at * 100}% - ${GAP}px)`, width: GAP * 2, top: `${area.y * 100}%`, height: `${area.h * 100}%` }
    : { top: `calc(${at * 100}% - ${GAP}px)`, height: GAP * 2, left: `${area.x * 100}%`, width: `${area.w * 100}%` }
  const fromPointer = (clientX: number, clientY: number) => {
    const box = container()?.getBoundingClientRect()
    if (!box?.width || !box.height) return
    const position = row ? (clientX - box.left) / box.width : (clientY - box.top) / box.height
    onChange(path, clampRatio(row ? (position - area.x) / area.w : (position - area.y) / area.h))
  }
  const keys: Record<string, number> = row ? { ArrowLeft: -0.05, ArrowRight: 0.05 } : { ArrowUp: -0.05, ArrowDown: 0.05 }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const next = event.key === 'Home' ? MIN_RATIO : event.key === 'End' ? MAX_RATIO : keys[event.key] !== undefined ? clampRatio(ratio + keys[event.key]) : undefined
    if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault(); event.stopPropagation()
    onChange(path, next); onCommit()
  }
  return <div className={'terminal-divider' + (dragging ? ' is-dragging' : '')} style={style} role="separator" tabIndex={0} aria-orientation={row ? 'vertical' : 'horizontal'}
    aria-label={row ? t('terminal.pane.resizeRow') : t('terminal.pane.resizeColumn')}
    aria-valuenow={Math.round(ratio * 100)} aria-valuemin={MIN_RATIO * 100} aria-valuemax={MAX_RATIO * 100} onKeyDown={onKeyDown}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true) }}
    onPointerMove={event => { if (dragging) fromPointer(event.clientX, event.clientY) }}
    onPointerUp={event => { if (!dragging) return; event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); onCommit() }}
    onPointerCancel={() => { if (dragging) { setDragging(false); onCommit() } }} />
}

export function TerminalPanel({ visible, workspaces, model, onOpenWork, createdTerminalId, screenReaderMode = false, onActivity, optionsSlot }: {
  visible: boolean; workspaces: WorkspaceGrant[]; model: string
  onOpenWork?: () => void; createdTerminalId?: string; screenReaderMode?: boolean
  /** All terminals together, for the Terminal tab above: working, an unseen finished result, or idle. */
  onActivity?: (state: ActivityState) => void
  /** Where the options button goes: the Assistant's control row. Without it the button sits in the tab bar. */
  optionsSlot?: HTMLElement | null
}) {
  const { t, i18n } = useTranslation()
  const api = window.electronAPI?.terminal
  const [state, setState] = useState<TerminalState | null>(null)
  const [kind, setKind] = useState<ShellKind>('powershell')
  const [directory, setDirectory] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Per-terminal remount counter: Reconnect rebuilds only that terminal's xterm.
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const [activity, setActivity] = useState<Record<string, ActivityState>>({})
  // Startup/exit options are rarely changed, so they stay folded away unless opened.
  const [scrollback, setScrollback] = useState(readScrollback)
  // Narrow windows stack side-by-side panes; the saved layout is unchanged.
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches)
  const mounted = useRef(true)
  const refreshing = useRef(false)
  const operation = useRef(false)
  const accepted = useRef<TerminalState | null>(null)
  const freshTerminal = useRef('')
  const focusOnActivate = useRef(false)
  const paneAreas = useRef<Record<string, HTMLDivElement | null>>({})
  // Bumped on every tab switch or divider move so a state refresh that started earlier cannot undo it.
  const selection = useRef(0)
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
    if (!api) { setError(t('terminal.bridgeUnavailable')); return }
    void api.get().then(accept).catch(report)
    return () => { mounted.current = false }
  }, [api])
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(NARROW), update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!directory && (workspaces[0] || state?.defaultDirectory)) setDirectory(workspaces[0]?.path || state!.defaultDirectory)
    if (!workspaces.some(folder => folder.id === workspaceId)) setWorkspaceId(workspaces[0]?.id || '')
  }, [workspaces, workspaceId, directory, state?.defaultDirectory])
  useEffect(() => {
    if (!visible || !api) return
    const refresh = () => {
      if (refreshing.current || operation.current) return
      refreshing.current = true
      const epoch = selection.current
      void api.get().then(next => { if (epoch === selection.current) accept(next) }).catch(report).finally(() => { refreshing.current = false })
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
    if (kind === 'opencode') { onOpenWork?.(); setCreating(false); return }
    const input: TerminalCreateInput = { id: crypto.randomUUID(), kind, directory: directory.trim(), cols: 100, rows: 30 }
    await perform(async () => { const next = await api.create(input); freshTerminal.current = input.id; if (mounted.current) setCreating(false); return next })
  }
  const sessions = new Map(state?.sessions.map(session => [session.id, session]))
  // Hosts without layouts (older saved files) show one pane per tab.
  const tabs: TerminalTab[] = state ? state.tabs ?? state.sessions.map(session => ({ id: session.id, layout: { pane: session.id }, focused: session.id })) : []
  const activeTab = state ? tabOf(tabs, state.activeId) ?? tabs[0] : undefined
  const active = state?.sessions.find(session => session.id === state.activeId)
  const paneSessions = (tab: TerminalTab) => panesOf(tab.layout).flatMap(id => sessions.get(id) ? [sessions.get(id)!] : [])
  const paneActivity = (session: TerminalSession): ActivityState => session.status === 'starting' ? 'working' : session.status === 'running' ? activity[session.id] ?? 'idle' : activity[session.id] === 'done' ? 'done' : 'idle'
  const working = (session: TerminalSession) => paneActivity(session) === 'working'
  const updateSession = (session: TerminalSession) => {
    const current = accepted.current
    if (!current) return
    const previous = current.sessions.find(item => item.id === session.id)
    if (previous && (previous.status !== session.status || previous.error !== session.error || previous.directory !== session.directory)) accept({ ...current, sessions: current.sessions.map(item => item.id === session.id ? session : item) })
  }
  // Switch locally first and never disable the clicked tab: a focused button that becomes disabled
  // strands keyboard focus, and the IME, outside every terminal.
  const select = (id: string) => {
    const current = accepted.current
    if (!api || !current || current.activeId === id || !current.sessions.some(session => session.id === id)) return
    const epoch = ++selection.current
    accept({ ...current, activeId: id, tabs: current.tabs?.map(tab => tab.focused !== id && panesOf(tab.layout).includes(id) ? { ...tab, focused: id } : tab) })
    void api.select(id).then(next => { if (epoch === selection.current) accept(next) })
      .catch(reason => { report(reason); void api.get().then(accept).catch(report) })
  }
  const focusPane = (id: string, focusTerminal: boolean) => { if (focusTerminal) focusOnActivate.current = true; select(id) }
  const markActivity = useCallback((id: string, state: ActivityState) => setActivity(current => (current[id] ?? 'idle') === state ? current : { ...current, [id]: state }), [])
  const summary = combineActivity((state?.sessions ?? []).map(paneActivity))
  const reportActivity = useRef(onActivity); reportActivity.current = onActivity
  useEffect(() => { reportActivity.current?.(summary) }, [summary])
  const closeSessions = (targets: TerminalSession[]) => perform(async () => {
    let next = accepted.current!
    for (const session of targets) next = await api.close(session.id)
    return next
  })
  const closePane = (session: TerminalSession) => {
    if (working(session) && !window.confirm(t('terminal.pane.closeConfirm'))) return
    void closeSessions([session])
  }
  const moveDivider = (tab: TerminalTab, path: string, ratio: number) => {
    const current = accepted.current
    if (!current?.tabs) return
    ++selection.current
    accept({ ...current, tabs: current.tabs.map(item => item.id === tab.id ? { ...item, layout: setRatio(item.layout, path, ratio) } : item) })
  }
  const saveDividers = (tab: TerminalTab) => {
    const layout = accepted.current?.tabs?.find(item => item.id === tab.id)?.layout
    if (!layout || !api.saveLayout) return
    ++selection.current
    void api.saveLayout(tab.id, layout).catch(report)
  }
  const splitBlocked = !state || !active || !activeTab ? t('terminal.split.none')
    : state.sessions.length >= 16 ? t('terminal.split.tooMany')
      : panesOf(activeTab.layout).length >= MAX_PANES ? t('terminal.split.maxPanes', { max: MAX_PANES })
        : !state.shells.find(shell => shell.kind === active.kind)?.available ? state.shells.find(shell => shell.kind === active.kind)?.reason || t('terminal.split.shellUnavailable') : ''
  // A new pane runs the focused pane's shell in that pane's current folder.
  const split = async (direction: SplitDirection) => {
    if (splitBlocked || !active || busy) return
    const input: TerminalCreateInput = { id: crypto.randomUUID(), kind: active.kind, directory: active.directory, cols: active.cols, rows: active.rows, split: { beside: active.id, direction } }
    await perform(async () => { const next = await api.create(input); freshTerminal.current = input.id; focusOnActivate.current = true; return next })
  }
  const arrows: Record<string, PaneDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
  // Panel-wide shortcuts. Only these combinations are taken from the shell; everything else passes through.
  const shortcuts = (event: ReactKeyboardEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    if (event.shiftKey && (event.code === 'Equal' || event.code === 'Minus')) {
      event.preventDefault(); event.stopPropagation()
      void split(event.code === 'Equal' ? 'row' : 'column')
      return
    }
    const direction = arrows[event.key]
    const target = !event.shiftKey && direction && activeTab && active ? neighborPane(activeTab.layout, active.id, direction, narrow) : undefined
    if (!target) return
    event.preventDefault(); event.stopPropagation()
    focusPane(target, true)
  }
  const available = state?.shells.find(shell => shell.kind === kind)
  const showForm = creating || state?.sessions.length === 0
  const restoreOn = state?.preferences.restoreOnStartup ?? true
  const optionsButton = <HeaderPopover rootProps={{ 'data-terminal-options': '' }} icon={<SlidersHorizontal size={16} aria-hidden="true" />} label={t('terminal.options.title')}
    title={t('terminal.options.title') + ' · ' + t('terminal.options.restoreSummary') + ': ' + (restoreOn ? t('terminal.options.on') : t('terminal.options.off'))} panelClassName="unified-terminal-preferences">
    <label><input type="checkbox" role="switch" aria-label={t('terminal.options.restore')} checked={restoreOn} disabled={!state || busy} onChange={event => { void perform(() => api.savePreferences({ ...state!.preferences, restoreOnStartup: event.target.checked })) }} /><span>{t('terminal.options.restore')}<small>{t('terminal.options.restoreHint')}</small></span></label>
    <label className="terminal-scrollback-field">{t('terminal.options.scrollback')}
      <select aria-label={t('terminal.options.scrollback')} value={scrollback} onChange={event => { const value = Number(event.target.value); try { saveScrollback(value); setScrollback(value) } catch (reason) { report(reason) } }}>
        {SCROLLBACK_CHOICES.map(value => <option key={value} value={value}>{t('terminal.options.scrollbackLines', { count: value, value: value.toLocaleString(i18n.language) })}</option>)}
      </select>
      <small>{t('terminal.options.scrollbackHint')}</small></label>
    <p>{t('terminal.options.quitHint')}</p>
  </HeaderPopover>
  const splitTitle = (direction: SplitDirection) => splitBlocked || (direction === 'row' ? t('terminal.split.rightTitle') : t('terminal.split.downTitle'))
  return <section className="unified-terminal" aria-label={t('terminal.panel')} onKeyDownCapture={shortcuts}>
    {/* Terminal options open from a button in the Assistant's control row, never as a row of their own. */}
    {optionsSlot && createPortal(optionsButton, optionsSlot)}
    <div className="unified-terminal-tabs">
      {!optionsSlot && optionsButton}
      {active && <button type="button" className="companion-icon-button terminal-current-folder" aria-label={t('terminal.openCurrentFolder')} title={active.directory} onClick={() => { void window.electronAPI.companion.openTerminalDirectory(active.id).catch(report) }}><FolderOpen size={16} /></button>}
      <div role="tablist" aria-label={t('terminal.tabs.label')}>{tabs.map((tab, index) => {
        const panes = paneSessions(tab)
        // The tab is named after its focused pane and shows activity while any of its panes is busy.
        const lead = sessions.get(tab.focused) || panes[0]
        if (!lead) return null
        const selected = tab.id === activeTab?.id, tabState = combineActivity(panes.map(paneActivity))
        return <div className={'unified-terminal-tab' + (selected ? ' is-active' : '')} key={tab.id}>
          <button type="button" role="tab" id={'terminal-tab-' + tab.id} aria-controls={'terminal-panel-' + tab.id} aria-selected={selected} tabIndex={selected ? 0 : -1} disabled={busy} onClick={() => { focusOnActivate.current = true; select(tab.focused) }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            select(tabs[next].focused); document.getElementById('terminal-tab-' + tabs[next].id)?.focus()
          }} title={lead.title + ' · ' + lead.directory + (panes.length > 1 ? ' · ' + t('terminal.pane.count', { n: panes.length }) : '') + (tabState !== 'idle' ? ' · ' + t('terminal.activity.' + tabState) : '')}><TerminalIcon size={14} /><span className="terminal-task">{label(lead)}</span><span className="terminal-kind">{badges[lead.kind]}</span>
            {panes.length > 1 && <span className="terminal-pane-count" aria-hidden="true">{panes.length}</span>}
            <ActivityMark state={tabState} idle={<i className={'terminal-dot ' + lead.status} aria-hidden="true" />} /></button>
          <button type="button" className="terminal-close" aria-label={t('terminal.tabs.close', { title: lead.title })} title={panes.length > 1 ? t('terminal.tabs.closeTabTitle') : t('terminal.tabs.closeTitle')} disabled={busy} onClick={() => { if (panes.some(session => session.status === 'running') && !window.confirm(t('terminal.tabs.closeConfirm'))) return; void closeSessions(panes) }}><X size={13} /></button>
        </div>
      })}</div>
      <Button variant="ghost" size="sm" aria-label={t('terminal.tabs.newLabel')} disabled={busy || !state || state.sessions.length >= 16} onClick={() => setCreating(value => !value)}><Plus size={15} /><span className="terminal-tool-label">{t('terminal.tabs.new')}</span></Button>
      {active && <>
        {/* Disabled buttons show no tooltip, so the reason sits on a wrapper. */}
        <span title={splitTitle('row')}><Button variant="ghost" size="sm" aria-label={t('terminal.split.right')} aria-keyshortcuts="Alt+Shift+=" disabled={busy || !!splitBlocked} onClick={() => { void split('row') }}><Columns2 size={14} /><span className="terminal-tool-label">{t('terminal.split.right')}</span></Button></span>
        <span title={splitTitle('column')}><Button variant="ghost" size="sm" aria-label={t('terminal.split.down')} aria-keyshortcuts="Alt+Shift+-" disabled={busy || !!splitBlocked} onClick={() => { void split('column') }}><Rows2 size={14} /><span className="terminal-tool-label">{t('terminal.split.down')}</span></Button></span>
        <Button variant="ghost" size="sm" aria-label={t('terminal.tabs.reconnect')} disabled={busy || active.status === 'starting' || active.status === 'running'} onClick={() => { void perform(async () => { const id = active.id; const next = await api.restart(id); freshTerminal.current = id; focusOnActivate.current = true; if (mounted.current) setRevisions(current => ({ ...current, [id]: (current[id] || 0) + 1 })); return next }) }}><RotateCw size={14} /><span className="terminal-tool-label">{t('terminal.tabs.reconnect')}</span></Button>
      </>}
    </div>
    {showForm && <div className="unified-terminal-create">
      <label>{t('terminal.create.shell')}<select aria-label={t('terminal.create.shell')} value={kind} disabled={busy} onChange={event => setKind(event.target.value as ShellKind)}>{(['powershell', 'cmd', 'wsl', 'opencode'] as const).map(item => <option key={item} value={item} disabled={!state?.shells.find(shell => shell.kind === item)?.available}>{names[item]}</option>)}</select></label>
      {kind === 'opencode' ? <label className="terminal-directory-field">{t('terminal.create.authorizedFolder')}<select aria-label={t('terminal.create.authorizedFolderLabel')} value={workspaceId} disabled={busy} onChange={event => setWorkspaceId(event.target.value)}><option value="">{t('terminal.create.chooseAuthorizedFolder')}</option>{workspaces.map(folder => <option key={folder.id} value={folder.id}>{folder.name} · {folder.writable ? t('terminal.create.writable') : t('terminal.create.readOnly')}</option>)}</select></label>
        : <label className="terminal-directory-field">{t('terminal.create.directory')}<div><input aria-label={t('terminal.create.directoryLabel')} value={directory} disabled={busy} placeholder="C:\\Projects" onChange={event => setDirectory(event.target.value)} /><button type="button" aria-label={t('terminal.create.chooseDirectory')} disabled={busy} onClick={() => { void api.pickDirectory().then(selected => { if (selected && mounted.current) setDirectory(selected) }).catch(report) }}><FolderOpen size={17} /></button></div></label>}
      <Button disabled={busy || !available?.available || (kind === 'opencode' ? !onOpenWork : !directory.trim())} onClick={() => { void create() }}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={15} />}{t('terminal.create.open')}</Button>
      {creating && !!state?.sessions.length && <Button variant="ghost" disabled={busy} onClick={() => setCreating(false)}>{t('terminal.create.cancel')}</Button>}
      {kind === 'opencode' && !model && <p>{t('terminal.create.selectModel')}</p>}
      {available && !available.available && <p role="status">{/* Empty in English, where the shell's own reason is shown instead. */}{(kind === 'wsl' ? t('terminal.create.wslMissing') : kind === 'opencode' ? t('terminal.create.opencodeMissing') : '') || available.reason}</p>}
    </div>}
    {error && <p className="companion-terminal-error" role="alert">{error}</p>}
    {!state && !error && <div className="terminal-empty" role="status"><LoaderCircle size={22} className="animate-spin" />{t('terminal.restoring')}</div>}
    {active && activeTab ? <div className="unified-terminal-stack">{tabs.map(tab => {
      const geometry = paneGeometry(tab.layout, narrow)
      const rects = new Map(geometry.panes.map(pane => [pane.id, pane.rect]))
      const tabActive = tab.id === activeTab.id, splitTab = geometry.panes.length > 1
      return <div key={tab.id} className={'unified-terminal-view' + (tabActive ? '' : ' is-inactive')} role="tabpanel" id={'terminal-panel-' + tab.id} aria-labelledby={'terminal-tab-' + tab.id}>
        <div className={'terminal-panes' + (splitTab ? ' is-split' : '')} ref={element => { paneAreas.current[tab.id] = element }}>
          {/* Creation order, not tree order: a new pane is appended, so existing xterms never move in the DOM. */}
          {state!.sessions.filter(session => rects.has(session.id)).map(session => <TerminalView key={session.id + ':' + (revisions[session.id] || 0)} session={session} tabActive={tabActive} focused={session.id === tab.focused} visible={visible}
            split={splitTab} activity={paneActivity(session)} style={placement(rects.get(session.id)!)} screenReaderMode={screenReaderMode}
            fresh={freshTerminal.current === session.id} focusOnActivate={focusOnActivate} onAttached={() => { if (freshTerminal.current === session.id) freshTerminal.current = '' }} onSession={updateSession} onActivity={markActivity}
            onFocusPane={focusPane} onClosePane={closePane} />)}
          {geometry.dividers.map(divider => <PaneDivider key={divider.path} path={divider.path} split={divider.split} ratio={divider.ratio} area={divider.area} container={() => paneAreas.current[tab.id]}
            onChange={(path, ratio) => moveDivider(tab, path, ratio)} onCommit={() => saveDividers(tab)} />)}
        </div>
      </div>
    })}</div>
      : state && <div className="terminal-empty"><TerminalIcon size={32} /><h2>{t('terminal.empty')}</h2>
</div>}
  </section>
}
