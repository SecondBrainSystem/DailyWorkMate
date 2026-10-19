import type { IDisposable, Terminal } from '@xterm/xterm'

/** What a terminal pane is doing, as shown on its tab: working, finished and not yet looked at, or idle. */
export type ActivityState = 'idle' | 'working' | 'done'

/**
 * Agent TUIs announce their own state in the terminal title. Claude Code alternates ◐/◑ while it works and
 * shows ✳ once it is waiting; other tools prefix a braille spinner. Undefined: the title says nothing about it.
 */
export function titleActivity(title: string): boolean | undefined {
  const first = [...title.trimStart()][0]
  if (!first) return undefined
  if ('◐◑◒◓'.includes(first) || /[⠁-⣿]/.test(first)) return true
  if ('✳✓✔'.includes(first)) return false
  return undefined
}

// Codex ("Working (5s • esc to interrupt)"), OpenCode ("esc interrupt") and Claude Code show this only while busy.
const INTERRUPT_HINT = /\b(?:esc|escape)\b[\s·•:]{0,3}(?:to\s+)?interrupt\b/i
export function screenShowsInterruptHint(screen: string): boolean { return INTERRUPT_HINT.test(screen) }

/** The rows currently on screen (not the scrolled viewport): where a TUI draws its status line. */
export function liveScreen(terminal: Pick<Terminal, 'rows' | 'buffer'>): string {
  const buffer = terminal.buffer.active, lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
  return lines.join('\n')
}

// Terminal answers and focus reports go through onData too, but they are not the user typing.
const AUTOMATIC_INPUT = /^(?:\x1b\[[\d;?>]*[IORcnt]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/
export const isUserInput = (data: string) => data.length > 0 && !AUTOMATIC_INPUT.test(data)

export interface ActivityTracker {
  /** Data the terminal sends to the PTY (keystrokes, pastes, terminal answers). */
  input(data: string): void
  /** New program output has been written to the terminal. */
  output(): void
  /** The shell printed its prompt (OSC 7): the previous command has ended. */
  prompt(): void
  /** The process exited or the pane stopped running. */
  ended(): void
  dispose(): void
}

/**
 * Per-pane activity, like Claude Code's own indicator: working only while something actually runs, then "done"
 * until the user types in that pane again, otherwise idle.
 *
 * A plain shell command runs from Enter until the next prompt (OSC 7). An interactive program (Claude Code,
 * Codex, OpenCode, a REPL, vim) is recognised by bracketed paste or the alternate screen. It counts as idle
 * while it waits for input and as working only on its own signal: a spinning title (Claude Code), the
 * "esc to interrupt" status (Codex, OpenCode), or, when it gives neither, sustained output after the user
 * submitted something (spinners and timers redraw while busy; start-up screens and echoes of typing do not count).
 */
export function trackActivity(terminal: Pick<Terminal, 'rows' | 'buffer' | 'modes' | 'onTitleChange'>, options: {
  onChange: (state: ActivityState) => void
  /** Shell panes report prompts and treat Enter as starting a command; direct TUIs (Work tabs) do not. */
  shellPrompts: boolean
  /** Replayed history must not count as new activity. */
  ignore?: () => boolean
  /** startDelay: a command must run this long before it shows; also lets a starting TUI identify itself. */
  startDelay?: number; settleDelay?: number; scanInterval?: number; quietDelay?: number; echoWindow?: number
}): ActivityTracker {
  const { onChange, shellPrompts, ignore = () => false, startDelay = 2000, settleDelay = 1200, scanInterval = 300, quietDelay = 4000, echoWindow = 500 } = options
  let state: ActivityState = 'idle', disposed = false
  // command: a shell command is running; started: it has run for startDelay. reason: why "working" is shown.
  let command = false, started = false, reason: 'command' | 'agent' | undefined
  let titleKnown = false, titleWorking = false, hintKnown = false, hintWorking = false
  // submitted: the user pressed Enter inside the interactive program; only then can its output mean work.
  let inputAt = -Infinity, outputs: number[] = [], submitted = false
  let startTimer: ReturnType<typeof setTimeout> | undefined, settleTimer: ReturnType<typeof setTimeout> | undefined
  let scanTimer: ReturnType<typeof setTimeout> | undefined, quietTimer: ReturnType<typeof setTimeout> | undefined, lastScan = 0
  const set = (next: ActivityState) => { if (!disposed && next !== state) { state = next; onChange(next) } }
  const interactive = () => !shellPrompts || terminal.modes.bracketedPasteMode || terminal.buffer.active.type === 'alternate' || titleKnown || hintKnown
  const busyOutput = () => { const now = Date.now(); outputs = outputs.filter(time => now - time < quietDelay); return submitted && outputs.length >= 2 }
  const agentWorking = () => titleKnown ? titleWorking || hintWorking : hintKnown ? hintWorking : busyOutput()
  const evaluate = () => {
    if (disposed) return
    const running = shellPrompts ? command : true
    const plain = running && !interactive()
    const working = plain ? started : running && agentWorking()
    if (working) { clearTimeout(settleTimer); settleTimer = undefined; reason = plain ? 'command' : 'agent'; set('working'); return }
    if (state !== 'working') return
    // A command that turns out to be an interactive program is waiting for the user: idle, not finished.
    if (reason === 'command') { reason = undefined; set('idle'); return }
    // Brief gaps between an agent's tool calls should not flash "done".
    if (!settleTimer) settleTimer = setTimeout(() => { settleTimer = undefined; if (state === 'working' && !(running && agentWorking())) { reason = undefined; submitted = false; set('done') } }, settleDelay)
  }
  const reset = () => {
    command = false; started = false; reason = undefined; titleKnown = false; titleWorking = false; hintKnown = false; hintWorking = false; outputs = []; submitted = false
    clearTimeout(startTimer); clearTimeout(settleTimer); clearTimeout(quietTimer); settleTimer = undefined
  }
  const scan = () => {
    scanTimer = undefined; lastScan = Date.now()
    if (disposed) return
    const hint = screenShowsInterruptHint(liveScreen(terminal))
    if (hint) hintKnown = true
    hintWorking = hint
    evaluate()
  }
  const title = terminal.onTitleChange(value => {
    if (disposed || ignore()) return
    const working = titleActivity(value)
    if (working === undefined) return
    titleKnown = true; titleWorking = working; evaluate()
  }) as IDisposable
  // Entering a full-screen program re-evaluates at once: it is waiting for the user until it signals work.
  const screen = terminal.buffer.onBufferChange(() => { if (!disposed && !ignore()) evaluate() }) as IDisposable
  return {
    input(data) {
      if (disposed || ignore() || !isUserInput(data)) return
      inputAt = Date.now()
      if (state === 'done') set('idle')
      if (!data.includes('\r')) return
      // Enter inside an interactive program submits a request; its output from now on may be work.
      if (!shellPrompts || (command && interactive())) { submitted = true; outputs = []; return }
      if (command) return
      command = true; started = false; clearTimeout(startTimer)
      startTimer = setTimeout(() => { started = true; evaluate() }, startDelay)
    },
    output() {
      if (disposed || ignore()) return
      const now = Date.now()
      // Redraws right after a keystroke are the program echoing the user, not working.
      if (now - inputAt > echoWindow) {
        outputs = [...outputs.filter(time => now - time < quietDelay), now]
        clearTimeout(quietTimer); quietTimer = setTimeout(evaluate, quietDelay)
      }
      if (!scanTimer) scanTimer = setTimeout(scan, Math.max(0, scanInterval - (now - lastScan)))
    },
    prompt() {
      if (disposed || ignore()) return
      const finished = state === 'working'
      reset(); set(finished ? 'done' : state)
    },
    ended() { const finished = state === 'working'; reset(); set(finished ? 'done' : state) },
    dispose() { disposed = true; reset(); clearTimeout(scanTimer); title.dispose(); screen.dispose() },
  }
}

/** One indicator for several panes or tabs: any work in progress wins, then any unseen result. */
export function combineActivity(states: Iterable<ActivityState | undefined>): ActivityState {
  let done = false
  for (const state of states) { if (state === 'working') return 'working'; if (state === 'done') done = true }
  return done ? 'done' : 'idle'
}
