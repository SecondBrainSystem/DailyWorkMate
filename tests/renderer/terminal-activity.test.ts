import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { combineActivity, isUserInput, reportedAgentActivity, screenShowsInterruptHint, titleActivity, trackActivity, type ActivityState } from '../../src/renderer/src/lib/terminalActivity.ts'

test('agent titles and status lines are recognised', () => {
  assert.equal(titleActivity('◐ Fix the login bug'), true, 'Claude Code working')
  assert.equal(titleActivity('◑ Fix the login bug'), true)
  assert.equal(titleActivity('✳ Fix the login bug'), false, 'Claude Code waiting')
  assert.equal(titleActivity('⠙ codex'), true, 'braille spinner')
  assert.equal(titleActivity('OC | session'), undefined, 'a plain title says nothing')
  assert.equal(titleActivity(''), undefined)
  assert.ok(screenShowsInterruptHint('• Working (12s • esc to interrupt)'), 'Codex')
  assert.ok(screenShowsInterruptHint('  esc interrupt   ctrl+p commands'), 'OpenCode')
  assert.ok(screenShowsInterruptHint('✻ Cogitating… (5s · ↓ 1.2k tokens · Esc to interrupt)'), 'Claude Code')
  assert.equal(screenShowsInterruptHint('PS C:\\work> git status'), false)
  assert.equal(screenShowsInterruptHint('press enter to interrupt and send'), false, 'needs the Esc key')
})

test('only typing counts as user input, not terminal answers or focus reports', () => {
  assert.equal(isUserInput('\x1b[I'), false); assert.equal(isUserInput('\x1b[O\x1b[I'), false)
  assert.equal(isUserInput('\x1b[12;40R'), false); assert.equal(isUserInput('\x1b]11;rgb:1616/1818/1d1d\x1b\\'), false)
  assert.equal(isUserInput('a'), true); assert.equal(isUserInput('\r'), true); assert.equal(isUserInput('\x1b[A'), true, 'arrow keys are typing')
})

test('several panes show work first, then an unseen result, else idle', () => {
  assert.equal(combineActivity(['idle', 'done', 'working']), 'working')
  assert.equal(combineActivity(['idle', 'done', undefined]), 'done')
  assert.equal(combineActivity([]), 'idle')
})

function fakeTerminal() {
  let screen: string[] = [''], type = 'normal', title = (_: string) => {}, bufferChange = () => {}
  const modes = { bracketedPasteMode: false }
  const handlers = new Map<number, (payload: string) => boolean>()
  const terminal = {
    rows: 3, modes,
    parser: { registerOscHandler: (number: number, callback: (payload: string) => boolean) => { handlers.set(number, callback); return { dispose: () => handlers.delete(number) } } },
    buffer: { get active() { return { type, baseY: 0, getLine: (row: number) => ({ translateToString: () => screen[row] ?? '' }) } }, onBufferChange: (listener: typeof bufferChange) => { bufferChange = listener; return { dispose() {} } } },
    onTitleChange: (listener: typeof title) => { title = listener; return { dispose() {} } },
  }
  return { terminal: terminal as never, modes, show: (...lines: string[]) => { screen = lines }, osc: (number: number, payload: string) => handlers.get(number)?.(payload), setTitle: (value: string) => title(value), alternate: () => { type = 'alternate'; bufferChange() } }
}
function setup(shellPrompts = true) {
  const fake = fakeTerminal(), states: ActivityState[] = []
  const tracker = trackActivity(fake.terminal, { onChange: state => states.push(state), shellPrompts })
  // A program redrawing (spinner or timer) delivers output on every poll.
  const animate = (ms: number, every = 100) => { for (let elapsed = 0; elapsed < ms; elapsed += every) { tracker.output(); mock.timers.tick(every) } }
  // Mock timers hand the end time to every callback of one big tick; step like real time instead.
  const pass = (ms: number) => { for (let elapsed = 0; elapsed < ms; elapsed += 100) mock.timers.tick(100) }
  return { ...fake, tracker, states, animate, pass, last: () => states.at(-1) ?? 'idle' }
}
const withTimers = (body: () => void) => { mock.timers.enable({ apis: ['setTimeout', 'Date'] }); try { body() } finally { mock.timers.reset() } }

test('a shell command works from Enter until the next prompt, then shows done until the user types', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('git status\r'); pane.animate(1000); pane.tracker.prompt()
  assert.deepEqual(pane.states, [], 'a short command never shows as working')
  pane.tracker.input('npm run build\r'); pane.pass(2000)
  assert.equal(pane.last(), 'working', 'a command still running after two seconds')
  pane.pass(10000); assert.equal(pane.last(), 'working', 'even while it prints nothing')
  pane.tracker.prompt(); assert.equal(pane.last(), 'done')
  pane.tracker.input('\x1b[I'); assert.equal(pane.last(), 'done', 'a focus report is not the user')
  pane.tracker.input('g'); assert.equal(pane.last(), 'idle')
  pane.tracker.dispose()
}))

test('Claude Code or Codex that is open but doing nothing stays idle', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('claude\r'); pane.pass(800)
  pane.modes.bracketedPasteMode = true; pane.animate(600)   // starting up: draws its input box
  pane.pass(30000)
  assert.deepEqual(pane.states, [], 'opening the agent never shows working')
  for (const key of 'refactor') { pane.tracker.input(key); pane.tracker.output(); pane.pass(150) }
  pane.pass(5000)
  assert.deepEqual(pane.states, [], 'typing into its input box (echo redraws) is not working')
  pane.tracker.dispose()
}))

test('Claude Code: its spinning title marks the turn; waiting again shows done', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('claude\r'); pane.pass(500); pane.setTitle('✳ Claude Code'); pane.modes.bracketedPasteMode = true
  pane.pass(5000); assert.deepEqual(pane.states, [])
  pane.tracker.input('fix the tests\r'); pane.setTitle('◐ Fix the tests'); assert.equal(pane.last(), 'working')
  pane.setTitle('◑ Fix the tests'); pane.setTitle('✳ Fix the tests'); pane.pass(500); pane.setTitle('◐ Fix the tests')
  pane.pass(2000); assert.equal(pane.last(), 'working', 'a short pause between tool calls does not flash done')
  pane.setTitle('✳ Fix the tests'); pane.animate(3000); assert.equal(pane.last(), 'done', 'the title decides even if the screen still redraws')
  pane.tracker.input('t'); assert.equal(pane.last(), 'idle', 'typing the next prompt clears done')
  pane.tracker.dispose()
}))

test('without title or status line, sustained redraws mean working and stillness means done', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('claude\r'); pane.modes.bracketedPasteMode = true; pane.pass(3000)
  pane.tracker.input('explain this repo\r'); pane.pass(600)
  pane.animate(3000); assert.equal(pane.last(), 'working', 'a spinner keeps redrawing')
  pane.pass(4000 + 1200); assert.equal(pane.last(), 'done', 'quiet again: the turn finished')
  pane.tracker.dispose()
}))

test('Codex and OpenCode: the interrupt status line marks the turn', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('codex\r'); pane.pass(500); pane.alternate(); pane.modes.bracketedPasteMode = true
  pane.show('', '› Ask Codex to do anything', ''); pane.animate(1000); pane.pass(10000)
  assert.deepEqual(pane.states, [], 'an open Codex waiting for a prompt is idle')
  pane.show('', '• Working (3s • esc to interrupt)', '› '); pane.animate(1000)
  assert.equal(pane.last(), 'working')
  pane.show('', 'Done. 3 files changed.', '› '); pane.animate(600)
  assert.equal(pane.last(), 'working', 'settling'); pane.pass(1200); assert.equal(pane.last(), 'done')
  pane.show('', 'Done. 3 files changed.', '› '); pane.animate(3000); assert.equal(pane.last(), 'done', 'once the status line is known, redraws alone do not count')
  pane.tracker.prompt(); assert.equal(pane.last(), 'done', 'quitting keeps the unseen result')
  pane.tracker.dispose()
}))

test('Work tabs run a TUI directly: idle until it signals work', () => withTimers(() => {
  const pane = setup(false)
  pane.tracker.input('hello\r'); pane.animate(400); pane.pass(5000); assert.deepEqual(pane.states, [], 'echo of a submitted prompt')
  pane.show('esc interrupt'); pane.animate(600); assert.equal(pane.last(), 'working')
  pane.tracker.ended(); assert.equal(pane.last(), 'done', 'the process ending finishes the turn')
  pane.tracker.dispose()
}))

test('Codex through a multiplexer is recognised from its composer without terminal modes', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('codex\r')
  pane.show('OpenAI Codex', '› Ask Codex to do anything'); pane.animate(1000); pane.pass(4000)
  assert.equal(pane.last(), 'idle')
  pane.show('• Working (3s • esc to cancel)', '› '); pane.animate(1000)
  assert.equal(pane.last(), 'working')
  pane.show('Finished the changes.', '› '); pane.animate(500); pane.pass(2000)
  assert.equal(pane.last(), 'done')
  pane.tracker.input('next\r'); pane.show('• Working (1s • esc to stop)', '› '); pane.animate(600)
  assert.equal(pane.last(), 'working', 'a subsequent turn starts normally')
  pane.tracker.dispose()
}))

test('an interactive program stays interactive after paste mode is disabled', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('codex\r'); pane.modes.bracketedPasteMode = true; pane.animate(2400)
  pane.modes.bracketedPasteMode = false; pane.show('Ready for input'); pane.animate(5000)
  assert.equal(pane.last(), 'idle', 'does not revert to the still-running shell command')
  pane.tracker.prompt()
  pane.tracker.input('npm run build\r'); pane.pass(2200)
  assert.equal(pane.last(), 'working', 'the shell prompt resets interactive detection')
  pane.tracker.dispose()
}))

test('a neutral title replaces an old busy title, and the Codex composer overrides a stale spinner', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('codex\r'); pane.setTitle('⠙ Codex'); assert.equal(pane.last(), 'working')
  pane.setTitle('Codex'); pane.pass(1500)
  assert.equal(pane.last(), 'done')
  pane.setTitle('⠙ Codex'); pane.show('Finished', '› Ask Codex to do anything'); pane.animate(2000)
  assert.equal(pane.last(), 'done')
  pane.tracker.dispose()
}))

test('old interrupt text outside the composer and quoted instructions do not count as work', () => {
  assert.equal(screenShowsInterruptHint('• Working (3s • esc to interrupt)\noutput\nmore output\nresult\nfinished\n› '), false)
  assert.equal(screenShowsInterruptHint('› explain esc to interrupt'), false)
  assert.equal(screenShowsInterruptHint('> esc to interrupt'), false)
})

test('Claude keeps its title signal when tool output temporarily replaces the interrupt footer', () => withTimers(() => {
  const pane = setup()
  pane.tracker.input('claude\r'); pane.setTitle('◐ Run tests')
  pane.show('✻ Cogitating… (5s · Esc to interrupt)'); pane.animate(600)
  pane.show('Running tests'); pane.animate(3000)
  assert.equal(pane.last(), 'working')
  pane.setTitle('✳ Run tests'); pane.pass(1500)
  assert.equal(pane.last(), 'done')
  pane.tracker.dispose()
}))

test('Codex OSC 7501 stays working through quiet tools, screen redraws, stale titles and directory updates', () => withTimers(() => {
  const pane = setup()
  assert.equal(reportedAgentActivity('state=working:app=codex'), true)
  assert.equal(reportedAgentActivity('state=idle:app=codex'), false)
  assert.equal(reportedAgentActivity('state=idle:app=other'), undefined)
  assert.equal(reportedAgentActivity('state=something:app=codex'), undefined)
  pane.osc(7501, 'state=idle:app=codex'); pane.show('› Ask Codex to do anything'); pane.animate(1000)
  assert.equal(pane.last(), 'idle')
  // The turn can already be running when we attach: no local Enter event is required.
  pane.osc(7501, 'state=working:app=codex'); assert.equal(pane.last(), 'working')
  pane.setTitle('Codex'); pane.show('Tool output', '› '); pane.animate(3000)
  pane.tracker.directory(); pane.pass(60000)
  assert.equal(pane.last(), 'working', 'neither missing interrupt text nor an OSC 7 path update ends a turn')
  pane.show('• Working (8s • esc to interrupt)', '› '); pane.setTitle('⠙ Codex'); pane.animate(500)
  pane.osc(7501, 'state=idle:app=codex'); pane.pass(1500)
  assert.equal(pane.last(), 'done', 'the real end signal beats even a stale spinner and status row')
  pane.osc(7501, 'state=working:app=codex'); assert.equal(pane.last(), 'working')
  pane.osc(133, 'A'); assert.equal(pane.last(), 'done', 'return to a real shell prompt clears a crashed agent')
  pane.tracker.input('npm run build\r'); pane.pass(2200); assert.equal(pane.last(), 'working')
  pane.tracker.dispose()
}))

test('legacy Codex keeps working across tool-screen gaps and detects wrapped hints above long input', () => withTimers(() => {
  assert.ok(screenShowsInterruptHint('• Thinking (20s • esc to\n  interrupt)\n\n› draft\n  line two\n  line three\n  line four\n  line five\n  line six\nfooter'))
  assert.equal(screenShowsInterruptHint('› explain the text\n  esc to interrupt\n  in the manual'), false)
  const pane = setup()
  pane.show('• Working (3s • esc to interrupt)', '› '); pane.animate(1000)
  assert.equal(pane.last(), 'working', 'live busy text is sufficient after reconnect')
  pane.show('Running a tool...', '', ''); pane.animate(3000); pane.pass(20000)
  assert.equal(pane.last(), 'working', 'missing composer is unknown rather than finished')
  pane.show('Finished.', '› '); pane.animate(500); pane.pass(1500)
  assert.equal(pane.last(), 'done')
  pane.tracker.dispose()
}))
