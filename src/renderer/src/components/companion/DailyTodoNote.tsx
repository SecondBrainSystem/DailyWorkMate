import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarPlus, Check, FileText, ListTodo, NotebookPen, Pencil, Pin, Plus, RefreshCw } from 'lucide-react'
import { CopyTextButton } from '@/components/ui/copy-text-button'
import { TodoMarkdown } from './TodoMarkdown'
import { DAILY_NOTE_LIMIT } from '@/lib/dailyTodo'
import { markdownTasks, TODO_TASK_STATUSES, TODO_TASK_TEXT_LIMIT, type MarkdownTask, type TodoTaskEdit } from '@shared/todoMarkdown'
import type { DailyTodoModel } from '@/hooks/useDailyTodo'
import './daily-todo.css'

export function DailyTodoNote({ model }: { model: DailyTodoModel }) {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [taskEditor, setTaskEditor] = useState<{ edit: TodoTaskEdit; content: string; title: string } | null>(null)
  const taskInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => { setTaskEditor(null); setEditing(false) }, [model.identity])
  useEffect(() => {
    if (taskEditor) (taskEditor.edit.action === 'delete' ? cancelButton : taskInput).current?.focus()
  }, [taskEditor?.edit.action, taskEditor && 'line' in taskEditor.edit ? taskEditor.edit.line : undefined])
  const disabled = !model.writable || !model.ready || !!model.operation || !!model.error
  const openTaskEditor = (action: TodoTaskEdit['action'], task?: MarkdownTask) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    model.clearWriteError()
    setTaskEditor({ content: model.content, title: task?.text || '', edit: action === 'add' ? { action, text: '' }
      : action === 'edit' ? { action, line: task!.line, text: task!.title } : { action, line: task!.line } })
  }
  const closeTaskEditor = () => {
    setTaskEditor(null); model.clearWriteError()
    requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : addButton.current)?.focus())
  }
  const tasks = useMemo(() => markdownTasks(model.content), [model.content])
  const done = tasks.filter(task => task.done).length
  const date = new Date().toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', weekday: 'short' })
  return <section className="daily-todo-note" aria-labelledby="daily-todo-title">
    <header className="daily-todo-heading">
      <div><span className="daily-todo-eyebrow"><Pin size={11} aria-hidden="true" />{t('dailyTodo.pinned')}</span>
        <h2 id="daily-todo-title">Daily <span>Todo</span><span className="daily-todo-period">.</span></h2></div>
      <div className="daily-todo-tools">
        <CopyTextButton text={model.content} />
        <button type="button" aria-label={t('dailyTodo.refresh')} title={t('dailyTodo.refresh')} onClick={model.refresh} disabled={model.loading || !!model.operation || !!taskEditor}><RefreshCw size={14} className={model.loading ? 'animate-spin' : ''} /></button>
      </div>
    </header>
    <div className="daily-todo-dateline"><span>{date}</span>{tasks.length > 0 && <span>{t('dailyTodo.progress', { done, total: tasks.length })}</span>}</div>
    {tasks.length > 0 && <progress className="daily-todo-progress" max={tasks.length} value={done} aria-label={t('dailyTodo.progress', { done, total: tasks.length })} />}
    {tasks.length > 0 && <div className="daily-todo-summary" aria-label={t('dailyTodo.statusSummary')}>
      {TODO_TASK_STATUSES.map(status => <span key={status} className={'daily-todo-status is-' + status}>
        {t('dailyTodo.status.' + status)} <b>{tasks.filter(task => task.status === status).length}</b>
      </span>)}
    </div>}
    <div className="daily-todo-source">
      {model.source ? <FileText size={13} aria-hidden="true" /> : <NotebookPen size={13} aria-hidden="true" />}
      <select aria-label={t('dailyTodo.source')} disabled={!!model.operation || !!taskEditor} value={model.source?.id || 'personal'} onChange={event => { setEditing(false); model.select(event.target.value) }}>
        <option value="personal">{t('dailyTodo.personal')}</option>
        {model.sources.map(source => <option key={source.id} value={source.id}>{source.workspaceName} / {source.relativePath}</option>)}
      </select>
    </div>
    {!!model.error && <p className="daily-todo-warning" role="alert">{t('dailyTodo.readError')} <span>{model.error}</span><button type="button" onClick={model.refresh}>{t('dailyTodo.retry')}</button></p>}
    {!!model.storageError && <p className="daily-todo-warning" role="alert">{t('dailyTodo.saveError')}<span>{model.storageError}</span></p>}
    {!!model.writeError && <p className="daily-todo-warning" role="alert">{t('dailyTodo.writeError')}<span>{model.writeError}</span></p>}
    {editing && !model.source ? <div className="daily-todo-editor">
      <label htmlFor="daily-todo-edit">{t('dailyTodo.editLabel')}</label>
      <textarea id="daily-todo-edit" value={model.content} maxLength={DAILY_NOTE_LIMIT} onChange={event => model.edit(event.target.value)} placeholder={t('dailyTodo.placeholder')} />
      <button type="button" onClick={() => setEditing(false)}><Check size={14} />{t('dailyTodo.finishEditing')}</button>
    </div> : <div className="daily-todo-body" tabIndex={0} aria-label={t('dailyTodo.contents')}>
      {model.content.trim() ? <TodoMarkdown content={model.content} tasks={tasks} disabled={disabled || !!taskEditor}
        onChange={(line, status) => void model.changeTask(line, status)} onEdit={task => openTaskEditor('edit', task)} onDelete={task => openTaskEditor('delete', task)} />
        : <div className="daily-todo-empty"><NotebookPen size={26} strokeWidth={1.25} aria-hidden="true" /><p>{t(model.loading ? 'dailyTodo.loading' : 'dailyTodo.empty')}</p><span>{t(model.source ? 'dailyTodo.emptyFile' : 'dailyTodo.emptyHint')}</span>
          {!model.source && !taskEditor && <button type="button" onClick={() => setEditing(true)}><Pencil size={13} />{t('dailyTodo.write')}</button>}</div>}
    </div>}
    {taskEditor && <form className="daily-todo-task-editor" aria-label={t(taskEditor.edit.action === 'add' ? 'dailyTodo.addTask' : taskEditor.edit.action === 'delete' ? 'dailyTodo.delete' : 'dailyTodo.edit')}
      onKeyDown={event => { if (event.key === 'Escape' && !model.operation) { event.preventDefault(); closeTaskEditor() } }}
      onSubmit={event => { event.preventDefault(); void model.editTask(taskEditor.edit, taskEditor.content).then(saved => { if (saved) closeTaskEditor() }) }}>
      {taskEditor.edit.action === 'delete' ? <p>{t('dailyTodo.deleteConfirm', { task: taskEditor.title })}</p> : <>
        <label htmlFor="daily-todo-task-title">{t(taskEditor.edit.action === 'add' ? 'dailyTodo.addTask' : 'dailyTodo.taskContent')}</label>
        <input ref={taskInput} id="daily-todo-task-title" type="text" required maxLength={TODO_TASK_TEXT_LIMIT} value={taskEditor.edit.text}
          disabled={!!model.operation} placeholder={t('dailyTodo.taskPlaceholder')}
          onChange={event => { const text = event.target.value; setTaskEditor(current => current && current.edit.action !== 'delete'
            ? { ...current, edit: { ...current.edit, text } } : current) }} />
      </>}
      <div><button ref={cancelButton} type="button" disabled={!!model.operation} onClick={closeTaskEditor}>{t('dailyTodo.cancel')}</button>
        <button type="submit" disabled={disabled || taskEditor.edit.action !== 'delete' && !taskEditor.edit.text.trim()}>
          {t(model.operation === 'save' ? 'dailyTodo.saving' : taskEditor.edit.action === 'delete' ? 'dailyTodo.confirmDelete' : 'dailyTodo.saveTask')}
        </button></div>
    </form>}
    {!editing && !taskEditor && <button ref={addButton} type="button" className="daily-todo-add" disabled={disabled}
      title={!model.writable ? t('dailyTodo.readOnlyHint') : undefined} onClick={() => openTaskEditor('add')}><Plus size={14} aria-hidden="true" />{t('dailyTodo.addTask')}</button>}
    {model.source && <div className="daily-todo-rollover">
      <div className="daily-todo-copy-actions"><button type="button" onClick={() => void model.copyToday()} disabled={!model.writable || !!model.operation || !!taskEditor}
        title={t(model.writable ? 'dailyTodo.copyTodayHint' : 'dailyTodo.readOnlyHint')}>
        <CalendarPlus size={14} aria-hidden="true" />{t(model.operation === 'copy' ? 'dailyTodo.copying' : 'dailyTodo.copyToday')}
      </button>
      <button type="button" onClick={() => void model.copyToday('unfinished')} disabled={!model.writable || !!model.operation || !!taskEditor}
        title={t(model.writable ? 'dailyTodo.copyUnfinishedHint' : 'dailyTodo.readOnlyHint')}>
        <ListTodo size={14} aria-hidden="true" />{t(model.operation === 'copyUnfinished' ? 'dailyTodo.copying' : 'dailyTodo.copyUnfinished')}
      </button></div>
      <span>{t(model.writable ? 'dailyTodo.copyTodayDetail' : 'dailyTodo.readOnlyHint')}</span>
      {model.copiedPath && <p role="status">{t('dailyTodo.created', { path: model.copiedPath })}</p>}
    </div>}
    <footer className="daily-todo-footer"><span role="status">{t(model.operation === 'save' ? 'dailyTodo.saving' : model.source ? model.writable ? 'dailyTodo.fileSaved' : 'dailyTodo.synced' : model.fromChat ? 'dailyTodo.fromChat' : model.storageError ? 'dailyTodo.unsaved' : 'dailyTodo.saved')}</span>
      {!model.source && !editing && !taskEditor && <button type="button" onClick={() => setEditing(true)}><Pencil size={12} />{t('dailyTodo.edit')}</button>}
    </footer>
    {(model.discoveryErrors.length > 0 || model.limited) && <details className="daily-todo-discovery"><summary>{t('dailyTodo.discoveryWarning')}</summary>
      {model.limited && <p>{t('dailyTodo.limited')}</p>}{model.discoveryErrors.map(error => <p key={error}>{error}</p>)}</details>}
  </section>
}
