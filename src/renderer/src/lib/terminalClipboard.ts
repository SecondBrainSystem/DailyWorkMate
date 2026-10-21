import type { Terminal } from '@xterm/xterm'

type CopyKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>
export function copiesTerminalSelection(event: CopyKey, selected: boolean): boolean {
  return selected && !event.isComposing && !event.altKey && event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey)
}

/** Copy the xterm selection, which is not a browser DOM selection. No selection: Ctrl+C is still SIGINT. */
export function enableTerminalCopy(terminal: Terminal, host: HTMLElement, onError: (error: unknown) => void): () => void {
  const copy = () => { void navigator.clipboard.writeText(terminal.getSelection()).catch(onError) }
  terminal.attachCustomKeyEventHandler(event => {
    if (!copiesTerminalSelection(event, terminal.hasSelection())) return true
    event.preventDefault(); event.stopPropagation()
    if (event.type === 'keydown') copy()
    return false
  })
  // Native context menus can't see xterm's canvas selection. Right-clicking a selection copies it.
  const contextmenu = (event: MouseEvent) => {
    if (!terminal.hasSelection()) return
    event.preventDefault(); event.stopPropagation(); copy()
  }
  host.addEventListener('contextmenu', contextmenu, true)
  return () => { terminal.attachCustomKeyEventHandler(() => true); host.removeEventListener('contextmenu', contextmenu, true) }
}
