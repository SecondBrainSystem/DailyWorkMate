import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarPlus, Check, FileText, NotebookPen, Pencil, Pin, RefreshCw } from 'lucide-react'
import { CopyTextButton } from '@/components/ui/copy-text-button'
import { TodoMarkdown } from './TodoMarkdown'
import { DAILY_NOTE_LIMIT } from '@/lib/dailyTodo'
import { markdownTasks } from '@shared/todoMarkdown'
import type { DailyTodoModel } from '@/hooks/useDailyTodo'
import './daily-todo.css'

export function DailyTodoNote({ model }: { model: DailyTodoModel }) {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = useState(false)
  const tasks = useMemo(() => markdownTasks(model.content), [model.content])
  const done = tasks.filter(task => task.done).length
  const date = new Date().toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', weekday: 'short' })
  return <section className="daily-todo-note" aria-labelledby="daily-todo-title">
    <header className="daily-todo-heading">
      <div><span className="daily-todo-eyebrow"><Pin size={11} aria-hidden="true" />{t('dailyTodo.pinned')}</span>
        <h2 id="daily-todo-title">Daily <span>Todo</span><span className="daily-todo-period">.</span></h2></div>
      <div className="daily-todo-tools">
        <CopyTextButton text={model.content} />
        <button type="button" aria-label={t('dailyTodo.refresh')} title={t('dailyTodo.refresh')} onClick={model.refresh} disabled={model.loading}><RefreshCw size={14} className={model.loading ? 'animate-spin' : ''} /></button>
      </div>
    </header>
    <div className="daily-todo-dateline"><span>{date}</span>{tasks.length > 0 && <span>{t('dailyTodo.progress', { done, total: tasks.length })}</span>}</div>
    {tasks.length > 0 && <progress className="daily-todo-progress" max={tasks.length} value={done} aria-label={t('dailyTodo.progress', { done, total: tasks.length })} />}
    <div className="daily-todo-source">
      {model.source ? <FileText size={13} aria-hidden="true" /> : <NotebookPen size={13} aria-hidden="true" />}
      <select aria-label={t('dailyTodo.source')} disabled={!!model.operation} value={model.source?.id || 'personal'} onChange={event => { setEditing(false); model.select(event.target.value) }}>
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
      {model.content.trim() ? <TodoMarkdown content={model.content} tasks={tasks} disabled={!model.writable || !!model.operation || !!model.error} onChange={(line, checked) => void model.changeTask(line, checked)} />
        : <div className="daily-todo-empty"><NotebookPen size={26} strokeWidth={1.25} aria-hidden="true" /><p>{t(model.loading ? 'dailyTodo.loading' : 'dailyTodo.empty')}</p><span>{t(model.source ? 'dailyTodo.emptyFile' : 'dailyTodo.emptyHint')}</span>
          {!model.source && <button type="button" onClick={() => setEditing(true)}><Pencil size={13} />{t('dailyTodo.write')}</button>}</div>}
    </div>}
    {model.source && <div className="daily-todo-rollover">
      <button type="button" onClick={() => void model.copyToday()} disabled={!model.writable || !!model.operation}
        title={t(model.writable ? 'dailyTodo.copyTodayHint' : 'dailyTodo.readOnlyHint')}>
        <CalendarPlus size={14} aria-hidden="true" />{t(model.operation === 'copy' ? 'dailyTodo.copying' : 'dailyTodo.copyToday')}
      </button>
      <span>{t(model.writable ? 'dailyTodo.copyTodayDetail' : 'dailyTodo.readOnlyHint')}</span>
      {model.copiedPath && <p role="status">{t('dailyTodo.created', { path: model.copiedPath })}</p>}
    </div>}
    <footer className="daily-todo-footer"><span role="status">{t(model.operation === 'save' ? 'dailyTodo.saving' : model.source ? model.writable ? 'dailyTodo.fileSaved' : 'dailyTodo.synced' : model.fromChat ? 'dailyTodo.fromChat' : model.storageError ? 'dailyTodo.unsaved' : 'dailyTodo.saved')}</span>
      {!model.source && !editing && <button type="button" onClick={() => setEditing(true)}><Pencil size={12} />{t('dailyTodo.edit')}</button>}
    </footer>
    {(model.discoveryErrors.length > 0 || model.limited) && <details className="daily-todo-discovery"><summary>{t('dailyTodo.discoveryWarning')}</summary>
      {model.limited && <p>{t('dailyTodo.limited')}</p>}{model.discoveryErrors.map(error => <p key={error}>{error}</p>)}</details>}
  </section>
}
