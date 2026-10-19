import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { fittedSize, terminalOptions, writeInChunks, TERMINAL_THEME, readScrollback, saveScrollback, shiftWheelLines, settledPtyResize, redrawTerminal, DEFAULT_SCROLLBACK, SCROLLBACK_CHOICES } from '../../src/renderer/src/lib/terminalDisplay.ts'

test('both terminal views share one xterm look and keep their own extra options', () => {
  const shell = terminalOptions(true, { cursorStyle: 'bar', cursorWidth: 1 })
  assert.equal(shell.fontSize, 14); assert.equal(shell.scrollback, 10000); assert.equal(shell.screenReaderMode, true); assert.equal(shell.cursorStyle, 'bar')
  assert.deepEqual(shell.theme, TERMINAL_THEME)
  assert.notEqual(shell.theme, terminalOptions(false).theme, 'each terminal gets its own theme object')
})

test('long input is written in order as 32768-character pieces and stops once the view is gone', async () => {
  const sent: string[] = []
  await writeInChunks('a'.repeat(32768) + 'b'.repeat(32768) + 'c', async chunk => { sent.push(chunk) })
  assert.deepEqual(sent.map(chunk => [chunk[0], chunk.length]), [['a', 32768], ['b', 32768], ['c', 1]])
  let cancelled = false
  const partial: string[] = []
  await writeInChunks('x'.repeat(70000), async chunk => { partial.push(chunk); cancelled = true }, () => cancelled)
  assert.equal(partial.length, 1)
})

test('terminal size follows the host, is capped for the PTY and waits for layout', () => {
  const fit = (cols: number, rows: number) => ({ proposeDimensions: () => ({ cols, rows }) }) as never
  const host = (width: number, height: number) => ({ clientWidth: width, clientHeight: height }) as HTMLElement
  assert.deepEqual(fittedSize(host(800, 600), fit(120, 40)), { cols: 120, rows: 40 })
  assert.deepEqual(fittedSize(host(800, 600), fit(900, 400)), { cols: 500, rows: 250 })
  assert.equal(fittedSize(host(0, 600), fit(120, 40)), undefined, 'hidden views keep their size')
  assert.equal(fittedSize(host(800, 600), fit(Number.NaN, 40)), undefined)
  assert.equal(fittedSize(host(800, 600), fit(1, 40)), undefined)
})

test('terminal history size defaults to 10000 lines and only accepts the offered choices', () => {
  assert.equal(readScrollback(), DEFAULT_SCROLLBACK, 'no storage available falls back to the default')
  assert.ok(SCROLLBACK_CHOICES.includes(DEFAULT_SCROLLBACK))
  assert.throws(() => saveScrollback(123), /Invalid terminal history size/)
})

test('Shift+wheel scrolls whole rows in the wheel direction, including Windows horizontal reports', () => {
  assert.equal(shiftWheelLines({ deltaX: 0, deltaY: -120, deltaMode: 0 }, 20), -6, 'pixels up')
  assert.equal(shiftWheelLines({ deltaX: 120, deltaY: 0, deltaMode: 0 }, 20), 6, 'Chromium reports Shift+wheel as deltaX')
  assert.equal(shiftWheelLines({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 20), 3, 'line mode')
  assert.equal(shiftWheelLines({ deltaX: 0, deltaY: 4, deltaMode: 0 }, 20), 1, 'a tiny trackpad step still moves one row')
  assert.equal(shiftWheelLines({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 20), 0)
})

test('the PTY only receives the settled size, once, never the transient sizes of a layout change', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent: string[] = []
    const pty = settledPtyResize((cols, rows) => sent.push(cols + 'x' + rows), 150)
    pty.request(26, 2); pty.request(52, 2); pty.request(52, 14)
    mock.timers.tick(149); assert.deepEqual(sent, [])
    mock.timers.tick(1); assert.deepEqual(sent, ['52x14'])
    pty.request(52, 14); mock.timers.tick(150); assert.deepEqual(sent, ['52x14'], 'an unchanged size is not resent')
    pty.request(80, 24); pty.cancel(); mock.timers.tick(500); assert.deepEqual(sent, ['52x14'], 'cancel drops a pending size')
  } finally { mock.timers.reset() }
})

test('redraw jumps to the bottom and nudges the PTY one row so ConPTY and the program repaint', async () => {
  const calls: string[] = []
  const terminal = { cols: 120, rows: 30, scrollToBottom: () => calls.push('bottom'), refresh: (start: number, end: number) => calls.push('refresh ' + start + '-' + end) }
  await redrawTerminal(terminal, async (cols, rows) => { calls.push(cols + 'x' + rows) }, 0)
  assert.deepEqual(calls, ['bottom', '120x29', '120x30', 'refresh 0-29'])
})
