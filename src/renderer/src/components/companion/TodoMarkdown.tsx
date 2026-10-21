import { Children, createContext, isValidElement, useContext, useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { todoMarkdownSource, type MarkdownTask } from '@shared/todoMarkdown'

const TaskContext = createContext<MarkdownTask | undefined>(undefined)
const ControlsContext = createContext({ disabled: true, onChange: (_line: number, _checked: boolean) => {} })

function TaskCheckbox({ checked }: { checked?: boolean }) {
  const task = useContext(TaskContext), controls = useContext(ControlsContext)
  return <input type="checkbox" checked={!!checked} disabled={controls.disabled || !task}
    aria-label={task?.text || 'Todo'} onChange={event => { if (task) controls.onChange(task.line, event.target.checked) }} />
}

/** React escapes raw HTML; links and images are restricted to web URLs. No file URLs or executable HTML. */
export function TodoMarkdown({ content, tasks, disabled, onChange }: {
  content: string; tasks: MarkdownTask[]; disabled: boolean; onChange: (line: number, checked: boolean) => void
}) {
  const components = useMemo<Components>(() => ({
    li: ({ node, children, className }) => {
      const task = tasks.find(item => item.line === (node?.position?.start.line || 0) - 1)
      const parts = Children.toArray(children), nested = (child: typeof parts[number]) => isValidElement(child) && (child.type === 'ul' || child.type === 'ol')
      return <TaskContext.Provider value={task}><li className={task ? 'daily-todo-task' + (task.done ? ' is-done' : '') : className}>
        {task ? <><div className="daily-todo-task-text">{parts.filter(child => !nested(child))}</div>{parts.filter(nested)}</> : children}
      </li></TaskContext.Provider>
    },
    input: ({ checked }) => <TaskCheckbox checked={checked} />,
    table: ({ children }) => <div className="daily-todo-table"><table>{children}</table></div>,
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={alt || ''} loading="lazy" /></a> : <span>{alt}</span>,
  }), [tasks])
  return <ControlsContext.Provider value={{ disabled, onChange }}><div className="daily-todo-markdown">
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}>
      {todoMarkdownSource(content)}
    </Markdown>
  </div></ControlsContext.Provider>
}
