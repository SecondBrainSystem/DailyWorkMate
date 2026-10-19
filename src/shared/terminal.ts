import { boundedText } from './companion'
import type { AgentInput } from './companion'
import type { PaneLayout, SplitDirection, TerminalTab } from './terminalTabs'

/** `opencode` is listed so the Terminal panel can route to a Work tab; the terminal host never runs it. */
export type ShellKind = 'powershell' | 'cmd' | 'wsl' | 'opencode'
export interface TerminalPreferences {
  restoreOnStartup: boolean
  /** Legacy, always false: terminals stop with the application. Kept so saved files and older callers stay valid. */
  keepRunningOnExit: boolean
}
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = { restoreOnStartup: true, keepRunningOnExit: false }
export interface TerminalCreateInput {
  id: string; kind: ShellKind; directory: string; cols: number; rows: number
  opencode?: Omit<AgentInput, 'prompt' | 'history'>
  /** Open as a new pane next to `beside`, in that pane's tab, instead of as a new tab. */
  split?: { beside: string; direction: SplitDirection }
}
export interface TerminalSession {
  id: string; kind: ShellKind; title: string; directory: string; cols: number; rows: number
  status: 'starting' | 'running' | 'exited' | 'error'; error: string; createdAt: number
  sessionId?: string; opencode?: TerminalCreateInput['opencode']
}
export interface TerminalState {
  defaultDirectory: string
  preferences: TerminalPreferences; sessions: TerminalSession[]; activeId: string
  shells: Array<{ kind: ShellKind; available: boolean; reason: string }>
  /** Pane layout per tab; `activeId` is the focused pane of the active tab. Absent: one pane per tab. */
  tabs?: TerminalTab[]
}
export interface TerminalOutput { data: string; cursor: number; reset: boolean; session: TerminalSession }
export interface TerminalManagerAPI {
  get: () => Promise<TerminalState>
  create: (input: TerminalCreateInput) => Promise<TerminalState>
  select: (id: string) => Promise<TerminalState>
  close: (id: string) => Promise<TerminalState>
  restart: (id: string) => Promise<TerminalState>
  poll: (id: string, cursor: number) => Promise<TerminalOutput>
  write: (id: string, data: string) => Promise<void>
  resize: (id: string, cols: number, rows: number) => Promise<void>
  savePreferences: (preferences: TerminalPreferences) => Promise<TerminalState>
  /** Persist divider positions; the panes of the tab must stay the same. */
  saveLayout: (tabId: string, layout: PaneLayout) => Promise<TerminalState>
  pickDirectory: () => Promise<string | null>
}
export function terminalId(value: unknown): string {
  const id = boundedText(value, 'terminal ID', 36, true)
  if (!/^[a-f0-9-]{32,36}$/.test(id)) throw new Error('Invalid terminal ID')
  return id
}
export function validateTerminalPreferences(value: TerminalPreferences): TerminalPreferences {
  if (!value || typeof value.restoreOnStartup !== 'boolean' || typeof value.keepRunningOnExit !== 'boolean') throw new Error('Invalid terminal preferences')
  // Accept the legacy field when reading saved tabs, but never retain ordinary processes on exit.
  return { restoreOnStartup: value.restoreOnStartup, keepRunningOnExit: false }
}
export function validateTerminalCreate(value: TerminalCreateInput): TerminalCreateInput {
  if (!value || !['powershell', 'cmd', 'wsl', 'opencode'].includes(value.kind)) throw new Error('Invalid terminal type')
  if (!Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500 || !Number.isInteger(value.rows) || value.rows < 2 || value.rows > 250) throw new Error('Invalid terminal dimensions')
  const opencode = value.opencode
  if (value.kind === 'opencode' && (!opencode || !opencode.workspaceId || !opencode.model)) throw new Error('Select an authorized folder and model for OpenCode')
  if (opencode && opencode.accessScope !== undefined && !['group', 'folder'].includes(opencode.accessScope)) throw new Error('Invalid OpenCode access scope')
  const split = value.split
  if (split !== undefined && (!split || (split.direction !== 'row' && split.direction !== 'column'))) throw new Error('Invalid terminal split')
  return { id: terminalId(value.id), kind: value.kind, directory: boundedText(value.directory, 'terminal directory', 4096, true), cols: value.cols, rows: value.rows,
    ...(value.kind === 'opencode' && opencode ? { opencode: {
      workspaceId: boundedText(opencode.workspaceId, 'workspace ID', 80, true), model: boundedText(opencode.model, 'model', 300, true),
      groupId: boundedText(opencode.groupId || '', 'group ID', 80), relativePath: boundedText(opencode.relativePath || '', 'relative path', 4096),
      accessScope: opencode.accessScope || 'group', sessionId: boundedText(opencode.sessionId || '', 'OpenCode session ID', 140),
    } } : {}),
    ...(split ? { split: { beside: terminalId(split.beside), direction: split.direction } } : {}) }
}
