/** Refit after both container and font/device-scale geometry changes settle.
 * xterm can update its cell size after our host resize callback has already run. */
export function observeTerminalLayout(host: HTMLElement, resize: () => void): () => void {
  let frame = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { frame = 0; resize() })
  })
  observer.observe(host)
  const screen = host.querySelector('.xterm-screen')
  if (screen) observer.observe(screen)
  return () => { observer.disconnect(); cancelAnimationFrame(frame) }
}

/** Windows shells run through the bundled ConPTY, which reflows and repaints the screen itself after a
 * resize. If xterm reflows as well, long-lived screens end up with truncated prompts and displaced text
 * (e.g. after entering or leaving focus mode). A pre-21376 build number makes xterm leave reflow to ConPTY. */
export const windowsPtyOptions = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
  ? { windowsPty: { backend: 'conpty' as const, buildNumber: 19041 } } : {}
