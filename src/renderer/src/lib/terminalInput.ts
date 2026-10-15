import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * xterm.js sends a plain Space only from `keypress`; every other printable key goes out on `keydown`.
 * Windows IMEs such as Microsoft Pinyin can deliver Space as an `insertText` input event without a
 * keypress, and xterm ignores that event while the key is held, so spaces vanish while letters work.
 * Forward such a space once, only when xterm itself has not sent one for that key press.
 */
export function forwardImeSpaces(terminal: Terminal): IDisposable {
  const textarea = terminal.textarea
  if (!textarea) return { dispose: () => {} }
  let spaceDown = false
  let sent = false
  const keydown = (event: KeyboardEvent) => {
    spaceDown = event.code === 'Space' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing
    sent = false
  }
  const data = terminal.onData(value => { if (/[ 　]/.test(value)) sent = true })
  const input = (event: Event) => {
    const { data: text, inputType, isComposing } = event as InputEvent
    if (!spaceDown || isComposing || inputType !== 'insertText' || !text || text.trim()) return
    spaceDown = false
    // xterm reports IME textarea changes on a zero-delay timer queued at keydown; check after it.
    setTimeout(() => { if (!sent && terminal.textarea) terminal.input(text, true) }, 0)
  }
  textarea.addEventListener('keydown', keydown, true)
  textarea.addEventListener('input', input)
  return { dispose: () => { data.dispose(); textarea.removeEventListener('keydown', keydown, true); textarea.removeEventListener('input', input) } }
}
