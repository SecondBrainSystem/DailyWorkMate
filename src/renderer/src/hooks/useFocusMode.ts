import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Leaves (and enters) focus mode from anywhere, including a focused terminal. */
export const FOCUS_MODE_SHORTCUT = 'F11'
// Radix renders these only while open; each owns Escape until it closes.
const OPEN_POPUP = '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"],[role="listbox"][data-state="open"],[data-radix-popper-content-wrapper]'

type KeyLike = Pick<KeyboardEvent, 'key' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>
/**
 * Escape belongs to a focused terminal (Claude Code, OpenCode and vim use it) and to open popups;
 * only otherwise does it leave focus mode. F11 toggles focus mode everywhere.
 */
export function focusModeKeyAction(event: KeyLike, context: { active: boolean; eligible: boolean; inTerminal: boolean; popupOpen: boolean }): 'toggle' | 'exit' | null {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === FOCUS_MODE_SHORTCUT && !event.shiftKey) return context.active || context.eligible ? 'toggle' : null
  if (event.key === 'Escape' && !event.shiftKey && context.active && !context.inTerminal && !context.popupOpen) return 'exit'
  return null
}

type KeyboardLock = { lock(keys?: string[]): Promise<void>; unlock(): void }
const keyboardLock = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard

/** Fullscreen changes the layout only; mounted terminals keep their processes and input. */
export function useFocusMode(enabled: boolean, surface: RefObject<HTMLElement>) {
  const [active, setActive] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const eligible = useRef(enabled)
  const owned = useRef(false)
  const mounted = useRef(true)
  const changing = useRef(false)
  eligible.current = enabled

  const exit = useCallback(async () => {
    if (owned.current && document.fullscreenElement === document.documentElement) await document.exitFullscreen()
  }, [])
  const toggleRef = useRef<() => Promise<void>>(async () => {})
  const report = useCallback((error: unknown) => {
    console.error('[Companion] Change focus mode:', error)
    if (mounted.current) setFailed(true)
  }, [])

  useEffect(() => {
    mounted.current = true
    let frame = 0
    const changed = () => {
      if (!owned.current) return
      const next = document.fullscreenElement === document.documentElement
      if (!next) { owned.current = false; keyboardLock()?.unlock() }
      setActive(next)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!eligible.current) return
        if (next) {
          const input = [...(surface.current?.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea') || [])]
            .find(element => element.getClientRects().length > 0)
          input?.focus({ preventScroll: true })
        } else button.current?.focus({ preventScroll: true })
      })
    }
    const escape = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const action = focusModeKeyAction(event, { active: owned.current, eligible: eligible.current,
        inTerminal: !!target?.closest('.xterm'), popupOpen: !!document.querySelector(OPEN_POPUP) })
      if (!action) return
      event.preventDefault()
      // F11 must not also reach the terminal as an escape sequence.
      if (action === 'toggle') { event.stopPropagation(); void toggleRef.current() }
      else void exit().catch(report)
    }
    document.addEventListener('fullscreenchange', changed)
    document.addEventListener('keydown', escape, true)
    return () => {
      mounted.current = false
      cancelAnimationFrame(frame)
      document.removeEventListener('fullscreenchange', changed)
      document.removeEventListener('keydown', escape, true)
      void exit().catch(error => console.error('[Companion] Leave focus mode:', error))
    }
  }, [exit, report, surface])

  useEffect(() => { if (!enabled) void exit().catch(report) }, [enabled, exit, report])

  const toggle = async () => {
    if (changing.current || !enabled) return
    changing.current = true
    setPending(true); setFailed(false)
    try {
      if (owned.current) await exit()
      else {
        if (document.fullscreenElement) throw new Error('Another fullscreen view is already open')
        owned.current = true
        // Fullscreen the document so body-portalled folder/session dialogs remain usable.
        await document.documentElement.requestFullscreen()
        if (!mounted.current || !eligible.current) await exit()
        // Electron exits HTML fullscreen on Escape before the page sees the key. Locking Escape
        // hands it to the page (terminal TUIs need it); holding Escape or F11 still leaves.
        else await keyboardLock()?.lock(['Escape']).catch(error => console.warn('[Companion] Escape stays reserved for leaving fullscreen:', error))
      }
    } catch (error) {
      if (!document.fullscreenElement) { owned.current = false; if (mounted.current) setActive(false) }
      report(error)
    } finally {
      changing.current = false
      if (mounted.current) setPending(false)
    }
  }

  toggleRef.current = toggle

  return { active: active && enabled, pending, failed, button, toggle }
}
