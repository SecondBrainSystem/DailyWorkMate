import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Nodes } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)
export interface MarkdownTask { line: number; offset: number; text: string; done: boolean }

/** Hide YAML metadata without shifting any source line or character offsets. */
export function todoMarkdownSource(content: string): string {
  return content.replace(/^\uFEFF/, ' ').replace(/^(?: )?---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/,
    value => value.replace(/[^\r\n]/g, ' '))
}

function nodeText(node: Nodes): string {
  if ('value' in node) return node.value
  return 'children' in node ? node.children.map(nodeText).join('') : ''
}

/** Use the same GFM parser as the view: examples in code/HTML are never editable tasks. */
export function markdownTasks(content: string): MarkdownTask[] {
  const tree = parser.parse(todoMarkdownSource(content)) as Root
  const collect = (node: Nodes): MarkdownTask[] => {
    const start = node.position?.start
    const prefix = node.type === 'listItem' && typeof node.checked === 'boolean' && start?.offset !== undefined
      ? content.slice(start.offset).match(/^(?:[-*+]|\d+[.)])[\t ]+\[([ xX])\](?=\s|$)/) : null
    const task = prefix && start?.offset !== undefined && node.type === 'listItem'
      ? [{ line: start.line - 1, offset: start.offset + prefix[0].lastIndexOf('[') + 1,
          text: nodeText(node.children[0]), done: node.checked === true }] : []
    return [...task, ...('children' in node ? node.children.flatMap(collect) : [])]
  }
  return collect(tree)
}

export function setMarkdownTask(content: string, line: number, checked: boolean): string {
  const task = markdownTasks(content).find(item => item.line === line)
  if (!task) throw new Error('待办项已变化，请刷新后重试。 / This task changed; refresh and try again.')
  return content.slice(0, task.offset) + (checked ? 'x' : ' ') + content.slice(task.offset + 1)
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
