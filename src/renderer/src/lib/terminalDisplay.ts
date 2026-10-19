import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { windowsPtyOptions } from './terminalLayout.ts'

/** Shared look of every xterm in the app: Terminal panel shells and the native Work TUIs. */
export const TERMINAL_THEME = { background: '#16181d', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#675174' }
export function terminalOptions(screenReaderMode: boolean, extra: ITerminalOptions = {}): ITerminalOptions {
  return { cursorBlink: true, fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace', fontSize: 14, lineHeight: 1.15, scrollback: readScrollback(),
    screenReaderMode, ...windowsPtyOptions, theme: { ...TERMINAL_THEME }, ...extra }
}

/** The size that fits the host, capped to what the PTY accepts; undefined while hidden or not laid out yet. */
export function fittedSize(host: HTMLElement | null | undefined, fit: FitAddon): { cols: number; rows: number } | undefined {
  if (!host?.clientWidth || !host.clientHeight) return undefined
  const size = fit.proposeDimensions()
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols < 2 || size.rows < 2) return undefined
  return { cols: Math.min(size.cols, 500), rows: Math.min(size.rows, 250) }
}

/** Terminal IPC accepts at most 64 KiB per write, so long pastes go out as ordered 32768-character pieces. */
export async function writeInChunks(value: string, send: (chunk: string) => Promise<unknown>, cancelled: () => boolean = () => false) {
  for (let offset = 0; offset < value.length && !cancelled(); offset += 32768) await send(value.slice(offset, offset + 32768))
}

// Scrollback is a per-device display preference: memory grows with it, and open terminals apply changes live.
export const SCROLLBACK_CHOICES: readonly number[] = [1000, 5000, 10000, 20000, 50000]
export const DEFAULT_SCROLLBACK = 10000
const SCROLLBACK_KEY = 'dailyworkmate.terminal.scrollback'
const SCROLLBACK_EVENT = 'dailyworkmate:terminal-scrollback'
export function readScrollback(): number {
  try { const value = Number(globalThis.localStorage?.getItem(SCROLLBACK_KEY)); return SCROLLBACK_CHOICES.includes(value) ? value : DEFAULT_SCROLLBACK }
  catch { return DEFAULT_SCROLLBACK }
}
export function saveScrollback(value: number) {
  if (!SCROLLBACK_CHOICES.includes(value)) throw new Error('Invalid terminal history size')
  try { localStorage.setItem(SCROLLBACK_KEY, String(value)) } catch (error) { console.warn('[Terminal] History size applies to this session only:', error) }
  window.dispatchEvent(new CustomEvent(SCROLLBACK_EVENT))
}
/** Keeps a live terminal's scrollback in step with changes from this window or another one. */
export function followScrollback(terminal: Terminal): () => void {
  const apply = () => { terminal.options.scrollback = readScrollback() }
  const storage = (event: StorageEvent) => { if (event.key === SCROLLBACK_KEY) apply() }
  window.addEventListener(SCROLLBACK_EVENT, apply); window.addEventListener('storage', storage)
  return () => { window.removeEventListener(SCROLLBACK_EVENT, apply); window.removeEventListener('storage', storage) }
}

/** Lines to scroll for one Shift+wheel step. Chromium on Windows reports Shift+wheel as horizontal scrolling. */
export function shiftWheelLines(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>, rowHeight: number): number {
  const delta = event.deltaY || event.deltaX
  if (!delta || !Number.isFinite(delta)) return 0
  const row = Math.max(rowHeight, 1)
  const pixels = event.deltaMode === 1 ? delta * row : event.deltaMode === 2 ? delta * row * 25 : delta
  return Math.sign(pixels) * Math.max(1, Math.round(Math.abs(pixels) / row))
}
/**
 * TUIs such as Claude Code, Codex or vim may capture the mouse, so the wheel goes to them instead of the
 * terminal history. Shift+wheel always scrolls the terminal's own history (the alternate screen has none).
 */
export function enableShiftWheelScroll(terminal: Terminal, host: HTMLElement): () => void {
  const wheel = (event: WheelEvent) => {
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.baseY === 0) return
    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    const lines = shiftWheelLines(event, (screen?.clientHeight || 0) / Math.max(terminal.rows, 1))
    if (!lines) return
    event.preventDefault(); event.stopPropagation()
    terminal.scrollLines(lines)
  }
  host.addEventListener('wheel', wheel, { capture: true, passive: false })
  return () => host.removeEventListener('wheel', wheel, { capture: true })
}

/**
 * xterm follows the layout at once, but the PTY only gets a size once it has settled. ConPTY reflows its
 * own buffer on every resize and cannot rejoin prompt lines it wrapped at a transient narrow width (e.g. one
 * frame of side-by-side panes while a window shrinks), so intermediate sizes must never reach it.
 */
export function settledPtyResize(send: (cols: number, rows: number) => void, delay = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined, sent = ''
  return {
    request(cols: number, rows: number) {
      clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; const key = cols + 'x' + rows; if (key !== sent) { sent = key; send(cols, rows) } }, delay)
    },
    cancel() { clearTimeout(timer); timer = undefined },
  }
}

/**
 * Recovery for a long-running TUI whose picture drifted from what the program believes it drew (e.g. Claude
 * Code's input box no longer visible while typing still works). Jump to the bottom and nudge the PTY size:
 * ConPTY repaints the whole screen and the program redraws itself, as when a window is resized.
 */
export async function redrawTerminal(terminal: Pick<Terminal, 'cols' | 'rows' | 'scrollToBottom' | 'refresh'>, send: (cols: number, rows: number) => Promise<unknown>, pause = 80) {
  terminal.scrollToBottom()
  const { cols, rows } = terminal
  if (rows > 2) { await send(cols, rows - 1); await new Promise(resolve => setTimeout(resolve, pause)) }
  await send(cols, rows)
  terminal.refresh(0, terminal.rows - 1)
}
