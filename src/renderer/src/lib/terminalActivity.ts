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
const INTERRUPT_HINT = /\b(?:esc|escape)\b[\s·•:]{0,3}(?:to\s+)?(?:interrupt|cancel|stop)\b/i
/** Codex emits OSC 7501 on turn transitions, including when its visible footer is redrawing. */
export function reportedAgentActivity(payload: string): boolean | undefined {
  if (!/(?:^|:)app=codex(?:$|:)/.test(payload)) return undefined
  const state = payload.match(/(?:^|:)state=(working|idle)(?:$|:)/)?.[1]
  return state === 'working' ? true : state === 'idle' ? false : undefined
}
/** Codex's input row stays visible while idle, even in the normal buffer or through a multiplexer. */
export function screenShowsAgentPrompt(screen: string): boolean { return /^\s*›(?:\s|$)/m.test(screen) }
export function screenShowsInterruptHint(screen: string): boolean {
  const lines = screen.split('\n')
  const prompt = lines.map(line => /^\s*›(?:\s|$)/.test(line)).lastIndexOf(true)
  // Only the live composer/status area, never an old status or quoted hint in the transcript.
  // Do not truncate a long/multiline composer from the bottom: its status lives ABOVE it.
  const footer = prompt < 0 ? lines.filter(line => line.trim()).slice(-8) : lines.slice(Math.max(0, prompt - 4), prompt)
  return footer.some((line, index) => !/^\s*(?:›|>|["'`])/.test(line) && (
    INTERRUPT_HINT.test(line) || (!!footer[index + 1] && INTERRUPT_HINT.test(line + ' ' + footer[index + 1].trim())
      && /\b(?:esc|escape)\b/i.test(line))
  ))
}

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
  /** The shell printed its actual prompt (OSC 133 A): the previous command has ended. */
  prompt(): void
  /** OSC 7 is a directory update, not proof that an interactive agent ended its turn. */
  directory(): void
  /** The process exited or the pane stopped running. */
  ended(): void
  dispose(): void
}

/**
 * Per-pane activity, like Claude Code's own indicator: working only while something actually runs, then "done"
 * until the user types in that pane again, otherwise idle.
 *
 * A plain shell command runs from Enter until the next prompt (OSC 133 A, legacy OSC 7). Codex's OSC 7501
 * turn state is authoritative when available. An interactive program (Claude Code,
 * Codex, OpenCode, a REPL, vim) is recognised by bracketed paste or the alternate screen. It counts as idle
 * while it waits for input and as working only on its own signal: a spinning title (Claude Code), the
 * "esc to interrupt" status (Codex, OpenCode), or, when it gives neither, sustained output after the user
 * submitted something (spinners and timers redraw while busy; start-up screens and echoes of typing do not count).
 */
export function trackActivity(terminal: Pick<Terminal, 'rows' | 'buffer' | 'modes' | 'onTitleChange'> & Partial<Pick<Terminal, 'parser'>>, options: {
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
  let interactiveKnown = false, composerKnown = false
  let reported: boolean | undefined
  // submitted: the user pressed Enter inside the interactive program; only then can its output mean work.
  let inputAt = -Infinity, outputs: number[] = [], submitted = false
  let startTimer: ReturnType<typeof setTimeout> | undefined, settleTimer: ReturnType<typeof setTimeout> | undefined
  let scanTimer: ReturnType<typeof setTimeout> | undefined, quietTimer: ReturnType<typeof setTimeout> | undefined, lastScan = 0
  const set = (next: ActivityState) => { if (!disposed && next !== state) { state = next; onChange(next) } }
  // TUIs can temporarily disable paste mode / leave the alternate screen between redraws. Once
  // identified, they remain interactive until the next shell prompt, not a long-running shell command.
  const interactive = () => interactiveKnown || !shellPrompts || terminal.modes.bracketedPasteMode || terminal.buffer.active.type === 'alternate' || titleKnown || hintKnown
  const busyOutput = () => { const now = Date.now(); outputs = outputs.filter(time => now - time < quietDelay); return submitted && outputs.length >= 2 }
  // Codex's composer is authoritative; Claude's title remains authoritative during tool-output gaps.
  const agentWorking = () => reported ?? (composerKnown ? hintWorking : titleKnown ? titleWorking || hintWorking : hintKnown ? hintWorking : busyOutput())
  const evaluate = () => {
    if (disposed || ignore()) return
    const running = !shellPrompts || command || reported === true || hintWorking
    if (running && interactive()) interactiveKnown = true
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
    command = false; started = false; reason = undefined; titleKnown = false; titleWorking = false; hintKnown = false; hintWorking = false; interactiveKnown = false; composerKnown = false; reported = undefined; outputs = []; submitted = false
    clearTimeout(startTimer); clearTimeout(settleTimer); clearTimeout(quietTimer); settleTimer = undefined
  }
  const scan = () => {
    scanTimer = undefined; lastScan = Date.now()
    if (disposed || ignore()) return
    const content = liveScreen(terminal), hint = screenShowsInterruptHint(content)
    const composer = screenShowsAgentPrompt(content)
    if (composer) composerKnown = true
    if (hint || composerKnown) { hintKnown = true; interactiveKnown = true }
    // No composer/status during a TUI repaint is unknown, not a completion signal.
    if (hint || composer || !composerKnown) hintWorking = hint
    evaluate()
  }
  const prompt = () => {
    if (disposed || ignore()) return
    const finished = state === 'working'
    reset(); set(finished ? 'done' : state)
  }
  const report = terminal.parser?.registerOscHandler(7501, payload => {
    if (disposed || ignore()) return false
    const value = reportedAgentActivity(payload)
    if (value === undefined) return false
    reported = value; interactiveKnown = true
    if (value) command = true
    evaluate(); return false
  })
  const shellPrompt = terminal.parser?.registerOscHandler(133, payload => {
    if (payload === 'A' || payload.startsWith('A;')) prompt()
    return false
  })
  const title = terminal.onTitleChange(value => {
    if (disposed || ignore()) return
    const working = titleActivity(value)
    // A neutral title replaces a spinner too; keeping the old title state latched leaves Codex busy.
    titleKnown = working !== undefined; titleWorking = working === true; evaluate()
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
    prompt,
    directory() { if (reported !== true && !hintWorking) prompt() },
    ended() { const finished = state === 'working'; reset(); set(finished ? 'done' : state) },
    dispose() { disposed = true; reset(); clearTimeout(scanTimer); title.dispose(); screen.dispose(); report?.dispose(); shellPrompt?.dispose() },
  }
}

/** One indicator for several panes or tabs: any work in progress wins, then any unseen result. */
export function combineActivity(states: Iterable<ActivityState | undefined>): ActivityState {
  let done = false
  for (const state of states) { if (state === 'working') return 'working'; if (state === 'done') done = true }
  return done ? 'done' : 'idle'
}
