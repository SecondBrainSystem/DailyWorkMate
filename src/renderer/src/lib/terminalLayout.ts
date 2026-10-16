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
