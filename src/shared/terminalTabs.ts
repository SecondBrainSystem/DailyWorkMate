/**
 * Split panes inside one Terminal tab. Each pane is one terminal session; a tab holds a small binary tree of
 * them. A split node divides its area into `first` and `second`: 'row' side by side, 'column' stacked.
 * A tree is the smallest model that mixes both directions in one tab (e.g. an editor shell on the left and
 * two stacked panes on the right); with at most four panes it stays tiny. All functions return new objects.
 */
export type SplitDirection = 'row' | 'column'
export type PaneLayout = { pane: string } | { split: SplitDirection; ratio: number; first: PaneLayout; second: PaneLayout }
export interface TerminalTab { id: string; layout: PaneLayout; focused: string }
export interface PaneRect { x: number; y: number; w: number; h: number }
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

export const MAX_PANES = 4
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85
const ID = /^[a-f0-9-]{32,36}$/

export const clampRatio = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)) : 0.5
export const panesOf = (layout: PaneLayout): string[] => 'pane' in layout ? [layout.pane] : [...panesOf(layout.first), ...panesOf(layout.second)]
export const tabOf = (tabs: TerminalTab[], pane: string) => tabs.find(tab => panesOf(tab.layout).includes(pane))

/** Replaces the `target` pane with a split whose second half is the new pane. */
export function splitPane(layout: PaneLayout, target: string, pane: string, direction: SplitDirection): PaneLayout {
  if ('pane' in layout) return layout.pane === target ? { split: direction, ratio: 0.5, first: layout, second: { pane } } : layout
  return { ...layout, first: splitPane(layout.first, target, pane, direction), second: splitPane(layout.second, target, pane, direction) }
}

/** The sibling takes over the closed pane's area; undefined once the last pane is gone. */
export function removePane(layout: PaneLayout, target: string): PaneLayout | undefined {
  if ('pane' in layout) return layout.pane === target ? undefined : layout
  const first = removePane(layout.first, target), second = removePane(layout.second, target)
  if (!first) return second
  if (!second) return first
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second }
}

/** The pane that inherits focus when `target` closes: the nearest pane of its sibling area. */
export function siblingPane(layout: PaneLayout, target: string): string | undefined {
  if ('pane' in layout) return undefined
  const isLeaf = (node: PaneLayout) => 'pane' in node && node.pane === target
  if (isLeaf(layout.first)) return panesOf(layout.second)[0]
  if (isLeaf(layout.second)) return panesOf(layout.first).at(-1)
  return siblingPane(layout.first, target) ?? siblingPane(layout.second, target)
}

/** Split nodes are addressed by path: '' is the root, then '0' (first) or '1' (second) per level. */
export function setRatio(layout: PaneLayout, path: string, ratio: number): PaneLayout {
  if ('pane' in layout) return layout
  if (!path) return { ...layout, ratio: clampRatio(ratio) }
  return path[0] === '0' ? { ...layout, first: setRatio(layout.first, path.slice(1), ratio) } : { ...layout, second: setRatio(layout.second, path.slice(1), ratio) }
}
export function ratioAt(layout: PaneLayout, path: string): number | undefined {
  if ('pane' in layout) return undefined
  return path ? ratioAt(path[0] === '0' ? layout.first : layout.second, path.slice(1)) : layout.ratio
}

/**
 * Fractional geometry of every pane and divider. `stacked` lays side-by-side splits out vertically,
 * for narrow windows; ratios and the saved layout are unchanged.
 */
export function paneGeometry(layout: PaneLayout, stacked = false) {
  const panes: Array<{ id: string; rect: PaneRect }> = []
  const dividers: Array<{ path: string; split: SplitDirection; ratio: number; area: PaneRect }> = []
  const walk = (node: PaneLayout, area: PaneRect, path: string) => {
    if ('pane' in node) { panes.push({ id: node.pane, rect: area }); return }
    const split: SplitDirection = stacked ? 'column' : node.split
    dividers.push({ path, split, ratio: node.ratio, area })
    if (split === 'row') {
      walk(node.first, { ...area, w: area.w * node.ratio }, path + '0')
      walk(node.second, { ...area, x: area.x + area.w * node.ratio, w: area.w * (1 - node.ratio) }, path + '1')
    } else {
      walk(node.first, { ...area, h: area.h * node.ratio }, path + '0')
      walk(node.second, { ...area, y: area.y + area.h * node.ratio, h: area.h * (1 - node.ratio) }, path + '1')
    }
  }
  walk(layout, { x: 0, y: 0, w: 1, h: 1 }, '')
  return { panes, dividers }
}

/** The adjacent pane in a direction (for Alt+Arrow), preferring the one sharing the longest edge. */
export function neighborPane(layout: PaneLayout, from: string, direction: PaneDirection, stacked = false): string | undefined {
  const { panes } = paneGeometry(layout, stacked)
  const origin = panes.find(item => item.id === from)?.rect
  if (!origin) return undefined
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
  const overlap = (a: number, aw: number, b: number, bw: number) => Math.min(a + aw, b + bw) - Math.max(a, b)
  let best: { id: string; shared: number } | undefined
  for (const { id, rect } of panes) {
    if (id === from) continue
    const touching = direction === 'right' ? near(rect.x, origin.x + origin.w) : direction === 'left' ? near(rect.x + rect.w, origin.x)
      : direction === 'down' ? near(rect.y, origin.y + origin.h) : near(rect.y + rect.h, origin.y)
    const shared = direction === 'left' || direction === 'right' ? overlap(origin.y, origin.h, rect.y, rect.h) : overlap(origin.x, origin.w, rect.x, rect.w)
    if (touching && shared > 1e-6 && (!best || shared > best.shared)) best = { id, shared }
  }
  return best?.id
}

/** Structural validation of an untrusted layout; ratios are clamped. Pane membership is checked by callers. */
export function validateLayout(value: unknown, depth = 0): PaneLayout {
  if (!value || typeof value !== 'object' || depth > MAX_PANES) throw new Error('Invalid terminal layout')
  const node = value as Record<string, unknown>
  if (typeof node.pane === 'string') {
    if (!ID.test(node.pane)) throw new Error('Invalid terminal pane ID')
    return { pane: node.pane }
  }
  if (node.split !== 'row' && node.split !== 'column') throw new Error('Invalid terminal split')
  const layout: PaneLayout = { split: node.split, ratio: clampRatio(node.ratio), first: validateLayout(node.first, depth + 1), second: validateLayout(node.second, depth + 1) }
  const panes = panesOf(layout)
  if (panes.length > MAX_PANES || new Set(panes).size !== panes.length) throw new Error('Invalid terminal layout')
  return layout
}

/**
 * Tabs for the restored sessions. Each saved tab is checked on its own: an invalid one is reported and its
 * sessions become single-pane tabs, panes of sessions that no longer exist are removed, and sessions that
 * no tab mentions (files written before split panes existed) get one tab each.
 */
export function normalizeTabs(sessionIds: string[], value: unknown): { tabs: TerminalTab[]; problems: string[] } {
  const known = new Set(sessionIds), used = new Set<string>(), tabIds = new Set<string>()
  const tabs: TerminalTab[] = [], problems: string[] = []
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    try {
      const item = entry as Partial<TerminalTab> | null
      if (!item || typeof item.id !== 'string' || !ID.test(item.id) || tabIds.has(item.id)) throw new Error('Invalid or duplicate tab ID')
      let layout: PaneLayout | undefined = validateLayout(item.layout)
      for (const pane of panesOf(layout)) if (!known.has(pane) || used.has(pane)) layout = layout && removePane(layout, pane)
      if (!layout) throw new Error('No restorable panes')
      const panes = panesOf(layout)
      panes.forEach(pane => used.add(pane)); tabIds.add(item.id)
      tabs.push({ id: item.id, layout, focused: typeof item.focused === 'string' && panes.includes(item.focused) ? item.focused : panes[0] })
    } catch (error) { problems.push('tab #' + index + ': ' + (error instanceof Error ? error.message : String(error))) }
  }
  for (const id of sessionIds) {
    if (used.has(id)) continue
    // A tab keeps its first session's ID; if that ID now names another tab, derive a free one.
    let tabId = id
    for (let digit = 0; tabIds.has(tabId) && digit < 16; digit++) tabId = id.slice(0, -1) + (digit % 16).toString(16)
    tabIds.add(tabId); used.add(id)
    tabs.push({ id: tabId, layout: { pane: id }, focused: id })
  }
  return { tabs, problems }
}
