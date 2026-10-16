import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

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
      if (!next) owned.current = false
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
      // Dialogs own Escape while open. Otherwise don't forward fullscreen-exit to the shell.
      if (!owned.current || event.key !== 'Escape' || event.isComposing || document.querySelector('[role="dialog"][data-state="open"]')) return
      event.preventDefault()
      event.stopPropagation()
      void exit().catch(report)
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
      }
    } catch (error) {
      if (!document.fullscreenElement) { owned.current = false; if (mounted.current) setActive(false) }
      report(error)
    } finally {
      changing.current = false
      if (mounted.current) setPending(false)
    }
  }

  return { active: active && enabled, pending, failed, button, toggle }
}
