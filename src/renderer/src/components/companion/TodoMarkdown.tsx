import { Children, createContext, isValidElement, useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isTodoTaskStatus, TODO_TASK_STATUSES, todoMarkdownSource, type MarkdownTask, type TodoTaskStatus } from '@shared/todoMarkdown'

const TaskContext = createContext<MarkdownTask | undefined>(undefined)
const ControlsContext = createContext({ disabled: true, onChange: (_line: number, _status: TodoTaskStatus) => {},
  onEdit: (_task: MarkdownTask) => {}, onDelete: (_task: MarkdownTask) => {} })

function TaskCheckbox({ checked }: { checked?: boolean }) {
  const task = useContext(TaskContext), controls = useContext(ControlsContext)
  return <input type="checkbox" aria-label={task?.text || 'Todo'} checked={task ? task.done : !!checked} disabled={controls.disabled || !task}
    ref={input => { if (input) input.indeterminate = task?.status === 'doing' }}
    aria-checked={task?.status === 'doing' ? 'mixed' : task ? task.done : !!checked}
    onChange={event => { if (task) controls.onChange(task.line, event.target.checked ? 'done' : 'todo') }} />
}

function TaskStatus() {
  const { t } = useTranslation()
  const task = useContext(TaskContext), controls = useContext(ControlsContext)
  if (!task) return null
  return <select className={'daily-todo-status is-' + task.status} aria-label={t('dailyTodo.taskStatus', { task: task.text })}
    value={task.status} disabled={controls.disabled} onChange={event => {
      if (isTodoTaskStatus(event.target.value)) controls.onChange(task.line, event.target.value)
    }}>{TODO_TASK_STATUSES.map(status => <option key={status} value={status}>{t('dailyTodo.status.' + status)}</option>)}</select>
}

function TaskActions() {
  const { t } = useTranslation()
  const task = useContext(TaskContext), controls = useContext(ControlsContext)
  if (!task) return null
  return <div className="daily-todo-task-actions"><TaskStatus /><div>
    <button type="button" disabled={controls.disabled} aria-label={t('dailyTodo.editTask', { task: task.text })}
      title={t('dailyTodo.edit')} onClick={() => controls.onEdit(task)}><Pencil size={13} aria-hidden="true" /></button>
    <button type="button" disabled={controls.disabled} aria-label={t('dailyTodo.deleteTask', { task: task.text })}
      title={t('dailyTodo.delete')} onClick={() => controls.onDelete(task)}><Trash2 size={13} aria-hidden="true" /></button>
  </div></div>
}

/** React escapes raw HTML; links and images are restricted to web URLs. No file URLs or executable HTML. */
export function TodoMarkdown({ content, tasks, disabled, onChange, onEdit, onDelete }: {
  content: string; tasks: MarkdownTask[]; disabled: boolean; onChange: (line: number, status: TodoTaskStatus) => void
  onEdit: (task: MarkdownTask) => void; onDelete: (task: MarkdownTask) => void
}) {
  const source = useMemo(() => todoMarkdownSource(content, tasks), [content, tasks])
  const components = useMemo<Components>(() => ({
    li: ({ node, children, className }) => {
      const task = tasks.find(item => item.line === (node?.position?.start.line || 0) - 1)
      const parts = Children.toArray(children), nested = (child: typeof parts[number]) => isValidElement(child) && (child.type === 'ul' || child.type === 'ol')
      return <TaskContext.Provider value={task}><li className={task ? 'daily-todo-task is-' + task.status : className}>
        {task ? <><TaskActions /><div className="daily-todo-task-text">{parts.filter(child => !nested(child))}</div>{parts.filter(nested)}</> : children}
      </li></TaskContext.Provider>
    },
    input: ({ checked }) => <TaskCheckbox checked={checked} />,
    table: ({ children }) => <div className="daily-todo-table"><table>{children}</table></div>,
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={alt || ''} loading="lazy" /></a> : <span>{alt}</span>,
  }), [tasks])
  return <ControlsContext.Provider value={{ disabled, onChange, onEdit, onDelete }}><div className="daily-todo-markdown">
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}>
      {source}
    </Markdown>
  </div></ControlsContext.Provider>
}
