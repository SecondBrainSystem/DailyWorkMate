import type { CompanionAPI, CompanionMessage, WorkspaceGrant } from '../../../shared/companion'

const DAILY = /(?:^|[^a-z0-9])(?:daily(?:[\s_-]*(?:to[\s_-]*dos?(?:[\s_-]*lists?)?|notes?|plans?|tasks?))?|to[\s_-]*dos?(?:[\s_-]*lists?)?)(?=$|[^a-z0-9])|待办|每日计划|今日计划/i
const TEXT_FILE = /\.(?:md|markdown|txt)$/i
const SKIP_DIRECTORY = /^(?:[._].*|node_modules|vendor|dist|build|out|target|coverage)$/i
export const DAILY_NOTE_LIMIT = 20000
export const mentionsDailyTodo = (text: string) => DAILY.test(text)

export interface DailyTodoSource {
  id: string
  workspaceId: string
  workspaceName: string
  relativePath: string
}
export interface DailyTodoDiscovery {
  sources: DailyTodoSource[]
  matched: boolean
  errors: string[]
  limited: boolean
}
export const dailySourceId = (workspaceId: string, relativePath: string) => JSON.stringify([workspaceId, relativePath])
export function localDay(date = new Date()): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
const dateInPath = (value: string) => value.match(/(?:^|[^\d])(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})(?!\d)/)?.slice(1).join('-') || ''

/** Today first, then the newest dated note (future plans come last), within the selected workspace. */
export function rankDailySources(sources: DailyTodoSource[], preferredWorkspace = '', today = localDay()): DailyTodoSource[] {
  const score = (source: DailyTodoSource) => {
    const date = dateInPath(source.relativePath)
    return (source.workspaceId === preferredWorkspace ? 10 : 0) + (date === today ? 4 : date && date < today ? 3 : date ? 0 : 2)
  }
  return [...sources].sort((a, b) => score(b) - score(a) || dateInPath(b.relativePath).localeCompare(dateInPath(a.relativePath)) || a.relativePath.localeCompare(b.relativePath))
}

/** Bounded, read-only discovery through the same authorization-checked IPC as the file browser. */
export async function discoverDailyTodos(
  api: Pick<CompanionAPI, 'listFiles'>, workspaces: WorkspaceGrant[], cancelled = () => false,
): Promise<DailyTodoDiscovery> {
  let queue = workspaces.map(workspace => ({
    workspace, relativePath: '', depth: 0,
    daily: mentionsDailyTodo(workspace.name) || mentionsDailyTodo(workspace.path.split(/[\\/]/).filter(Boolean).at(-1) || ''),
  }))
  let sources: DailyTodoSource[] = [], errors: string[] = [], matched = queue.some(item => item.daily), visited = 0, limited = false
  const seen = new Set<string>()
  while (queue.length && visited < 80 && !cancelled()) {
    const [item, ...rest] = queue
    queue = rest
    const key = dailySourceId(item.workspace.id, item.relativePath)
    if (seen.has(key)) continue
    seen.add(key); visited++
    try {
      const entries = await api.listFiles(item.workspace.id, item.relativePath)
      if (cancelled()) break
      // Prefer relevant folders when the workspace is large; keep the pending queue bounded too.
      for (const entry of [...entries].sort((a, b) => Number(mentionsDailyTodo(b.name)) - Number(mentionsDailyTodo(a.name)))) {
        // Main-process path validation is authoritative; don't enqueue malformed or escaped entries.
        if (!entry.relativePath || /^(?:[\\/]|[a-z]:)/i.test(entry.relativePath) || entry.relativePath.split(/[\\/]/).includes('..')) continue
        const daily = item.daily || mentionsDailyTodo(entry.name)
        if (entry.directory) {
          if (SKIP_DIRECTORY.test(entry.name)) continue
          if (daily) matched = true
          if (item.depth < (daily ? 4 : 2)) {
            if (queue.length + visited < 80) queue = [...queue, { ...item, relativePath: entry.relativePath, depth: item.depth + 1, daily }]
            else limited = true
          }
        } else if (daily && TEXT_FILE.test(entry.name)) {
          matched = true
          sources = [...sources, { id: dailySourceId(item.workspace.id, entry.relativePath), workspaceId: item.workspace.id, workspaceName: item.workspace.name, relativePath: entry.relativePath }]
        }
      }
    } catch (error) {
      errors = [...errors, `${item.workspace.name}/${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`]
    }
  }
  return { sources, matched, errors, limited: limited || queue.length > 0 }
}

export type DailyLine = { line: number; text: string; kind: 'task'; done: boolean }
  | { line: number; text: string; kind: 'heading' | 'text' }

/** Keep source line numbers for lossless local checkbox edits; code and YAML aren't tasks. */
export function dailyLines(content: string): DailyLine[] {
  let fence = '', frontmatter = false
  return content.replace(/\r\n/g, '\n').split('\n').flatMap<DailyLine>((text, line) => {
    if (line === 0 && text.trim() === '---') { frontmatter = true; return [] }
    if (frontmatter) { if (/^(---|\.\.\.)\s*$/.test(text)) frontmatter = false; return [] }
    const marker = text.trim().match(/^(`{3,}|~{3,})/)?.[1]
    if (marker) { fence = fence ? (marker[0] === fence[0] && marker.length >= fence.length ? '' : fence) : marker; return [] }
    if (fence || !text.trim() || /^\s*[-*_]{3,}\s*$/.test(text)) return []
    const task = text.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/)
    if (task) return [{ kind: 'task', line, text: task[2], done: task[1].toLowerCase() === 'x' }]
    const heading = text.match(/^#{1,6}\s+(.+?)\s*#*$/)
    return [{ kind: heading ? 'heading' : 'text', line, text: heading?.[1] || text }]
  })
}

export function toggleDailyTask(content: string, line: number): string {
  const separator = content.includes('\r\n') ? '\r\n' : '\n'
  return content.split(/\r?\n/).map((text, index) => index !== line ? text : text.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/,
    (_all, before, state, after) => before + (state === ' ' ? 'x' : ' ') + after,
  )).join(separator)
}

/** Only pull an explicit list from a Daily/Todo exchange, never unrelated later replies. */
export function dailyChatDraft(messages: Pick<CompanionMessage, 'role' | 'content'>[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const relevant = mentionsDailyTodo(message.content) || (message.role === 'assistant' && mentionsDailyTodo(messages[index - 1]?.content || ''))
    if (!relevant) continue
    const lines = dailyLines(message.content).filter(line => line.kind === 'task' || /^\s*(?:[-*+]|\d+[.)])\s+/.test(line.text))
    if (lines.length) return lines.map(line => line.kind === 'task'
      ? `- [${line.done ? 'x' : ' '}] ${line.text}`
      : line.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '- [ ] ')).join('\n').slice(0, DAILY_NOTE_LIMIT)
  }
  return ''
}

export interface DailyMemo { enabled: boolean; text: string; sourceId?: string; edited?: boolean }
export function parseDailyMemo(raw: string | null): DailyMemo {
  if (!raw) return { enabled: false, text: '' }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('enabled' in value) || typeof value.enabled !== 'boolean'
    || !('text' in value) || typeof value.text !== 'string' || value.text.length > DAILY_NOTE_LIMIT
    || ('sourceId' in value && typeof value.sourceId !== 'string')
    || ('edited' in value && typeof value.edited !== 'boolean')) throw new Error('Invalid saved Daily Todo note')
  return { enabled: value.enabled, text: value.text, ...('sourceId' in value ? { sourceId: value.sourceId as string } : {}), edited: 'edited' in value && value.edited === true }
}
