/** HashRouter navigation keeps the same renderer and must not terminate its Work tasks. */
export function shouldCloseWorkTerminalsForNavigation(isInPlace: boolean, isMainFrame: boolean): boolean {
  return isMainFrame && !isInPlace
}
