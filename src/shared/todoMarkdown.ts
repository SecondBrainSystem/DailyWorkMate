import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Nodes } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)
export type TodoTaskStatus = 'todo' | 'doing' | 'done'
export const TODO_TASK_STATUSES: readonly TodoTaskStatus[] = ['todo', 'doing', 'done']
export const isTodoTaskStatus = (value: unknown): value is TodoTaskStatus => value === 'todo' || value === 'doing' || value === 'done'
export const todoTaskMarker = (status: TodoTaskStatus): string => status === 'done' ? 'x' : status === 'doing' ? '/' : ' '
export interface MarkdownTask {
  line: number; offset: number; text: string; done: boolean; status: TodoTaskStatus
  start: number; end: number; title: string
}
export type TodoTaskEdit = { action: 'add'; text: string }
  | { action: 'edit'; line: number; text: string }
  | { action: 'delete'; line: number }
export const TODO_TASK_TEXT_LIMIT = 2000

/** Hide YAML metadata without shifting any source line or character offsets. */
function maskMetadata(content: string): string {
  return content.replace(/^\uFEFF/, ' ').replace(/^(?: )?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/,
    value => value.replace(/[^\r\n]/g, ' '))
}

function nodeText(node: Nodes): string {
  if ('value' in node) return node.value
  return 'children' in node ? node.children.map(nodeText).join('') : ''
}

/** Use the same GFM parser as the view: examples in code/HTML are never editable tasks. */
export function markdownTasks(content: string): MarkdownTask[] {
  const tree = parser.parse(maskMetadata(content)) as Root
  const collect = (node: Nodes): MarkdownTask[] => {
    const start = node.position?.start
    const prefix = node.type === 'listItem' && start?.offset !== undefined
      ? content.slice(start.offset).match(/^(?:[-*+]|\d+[.)])[\t ]+\[([ xX/])\](?=\s|$)/) : null
    const status: TodoTaskStatus = prefix?.[1] === '/' ? 'doing' : node.type === 'listItem' && node.checked ? 'done' : 'todo'
    const task = prefix && start?.offset !== undefined && node.type === 'listItem'
      && (typeof node.checked === 'boolean' || status === 'doing')
      ? [{ line: start.line - 1, offset: start.offset + prefix[0].lastIndexOf('[') + 1,
          text: status === 'doing' ? nodeText(node.children[0]).replace(/^\[\/\]\s*/, '') : nodeText(node.children[0]),
          done: status === 'done', status, start: start.offset, end: node.position!.end.offset!,
          title: content.slice(start.offset + prefix[0].length).match(/^[\t ]*([^\r\n]*)/)?.[1] || '' }] : []
    return [...task, ...('children' in node ? node.children.flatMap(collect) : [])]
  }
  return collect(tree)
}

/** Let GFM render doing items as checkboxes; only real task markers are masked, never code examples. */
export function todoMarkdownSource(content: string, tasks = markdownTasks(content)): string {
  const source = maskMetadata(content)
  let offset = 0
  const parts = tasks.filter(task => task.status === 'doing').map(task => {
    const part = source.slice(offset, task.offset) + ' '
    offset = task.offset + 1
    return part
  })
  return parts.join('') + source.slice(offset)
}

export function setMarkdownTask(content: string, line: number, value: boolean | TodoTaskStatus): string {
  const status = typeof value === 'boolean' ? value ? 'done' : 'todo' : value
  if (!isTodoTaskStatus(status)) throw new Error('Invalid todo task status')
  const task = markdownTasks(content).find(item => item.line === line)
  if (!task) throw new Error('待办项已变化，请刷新后重试。 / This task changed; refresh and try again.')
  return content.slice(0, task.offset) + todoTaskMarker(status) + content.slice(task.offset + 1)
}

function taskRange(content: string, task: MarkdownTask) {
  const lineStart = content.lastIndexOf('\n', task.start - 1) + 1
  // Keep a UTF-8 BOM even when deleting the first task.
  const start = lineStart === 0 && content.startsWith('\uFEFF') ? 1 : lineStart
  const end = task.end + (content.slice(task.end).match(/^\r?\n/)?.[0].length || 0)
  return { start, end, prefix: content.slice(start, task.start) }
}

/** Edit the task's first line; its Markdown formatting, status and child blocks stay intact. */
export function editMarkdownTask(content: string, edit: TodoTaskEdit): string {
  if (!edit || typeof edit !== 'object' || !['add', 'edit', 'delete'].includes(edit.action)
    || (edit.action !== 'add' && (!Number.isSafeInteger(edit.line) || edit.line < 0))) throw new Error('Invalid todo task edit')
  if (edit.action !== 'delete' && (typeof edit.text !== 'string' || !edit.text.trim()
    || edit.text.length > TODO_TASK_TEXT_LIMIT || /[\r\n\0]/.test(edit.text))) {
    throw new Error('请输入不超过 2000 字符的单行待办内容。 / Enter a task on one line, up to 2000 characters.')
  }
  if (edit.action === 'add') {
    const newline = content.match(/\r?\n/)?.[0] || '\n'
    const separator = !content || content === '\uFEFF' ? '' : content.endsWith(newline + newline) ? '' : content.endsWith(newline) ? newline : newline + newline
    const next = content + separator + '- [ ] ' + edit.text.trim() + newline
    if (!markdownTasks(next).some(task => task.start === content.length + separator.length)) {
      throw new Error('请先在原文中闭合代码块、HTML 或元数据，再添加待办。 / Close open code, HTML or metadata blocks before adding a task.')
    }
    return next
  }
  const task = markdownTasks(content).find(item => item.line === edit.line)
  if (!task) throw new Error('待办项已变化，请刷新后重试。 / This task changed; refresh and try again.')
  if (edit.action === 'delete') {
    const range = taskRange(content, task)
    return content.slice(0, range.start) + content.slice(range.end)
  }
  const titleStart = task.offset + 2
  const titleEnd = titleStart + (content.slice(titleStart).match(/^[^\r\n]*/)?.[0].length || 0)
  return content.slice(0, titleStart) + ' ' + edit.text.trim() + content.slice(titleEnd)
}

/** Remove completed task blocks, promoting unfinished descendants so no pending work is lost. */
export function unfinishedTodoMarkdown(content: string): string {
  const tasks = markdownTasks(content)
  const within = (parent: MarkdownTask, child: MarkdownTask) => child.start > parent.start && child.end <= parent.end
  const roots = (items: MarkdownTask[]) => items.filter(item => !items.some(parent => within(parent, item)))
  const render = (task: MarkdownTask): string => {
    const range = taskRange(content, task)
    const children = tasks.filter(child => within(task, child))
    if (task.done) {
      return roots(children.filter(child => !child.done)).map(child => {
        const childPrefix = taskRange(content, child).prefix
        return render(child).split(/(?<=\n)/).map(line => line.startsWith(childPrefix)
          ? range.prefix + line.slice(childPrefix.length) : line).join('')
      }).join('')
    }
    return replace(range.start, range.end, roots(children))
  }
  const replace = (start: number, end: number, items: MarkdownTask[]): string => {
    let cursor = start
    const parts = items.map(task => {
      const range = taskRange(content, task)
      const part = content.slice(cursor, range.start) + render(task)
      cursor = range.end
      return part
    })
    return parts.join('') + content.slice(cursor, end)
  }
  return replace(0, content.length, roots(tasks))
}

export const todoFilePattern = /\.(?:md|markdown|txt)$/i
const datePattern = /(?<!\d)(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?!\d)/
export const todoDate = (name: string) => name.match(datePattern)?.slice(1).join('-') || ''
export function localTodoDay(date = new Date()): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
/** Same-folder versions of the same note, without mixing other projects' lists. */
export function todoSeries(name: string): string {
  return name.replace(todoFilePattern, '').replace(/\s*\(\d+\)$/, '').replace(datePattern, '').replace(/[\s_-]+/g, '').toLowerCase()
}
export function datedTodoName(name: string, today: string, copy = 1): string {
  const extension = name.match(todoFilePattern)?.[0] || '.md'
  const stem = name.replace(todoFilePattern, '').replace(/\s*\(\d+\)$/, '')
  const dated = datePattern.test(stem) ? stem.replace(datePattern, today) : `${stem}-${today}`
  return dated + (copy > 1 ? ` (${copy})` : '') + extension
}
