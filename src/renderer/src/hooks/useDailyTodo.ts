import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompanionAPI, CompanionMessage, TodoCopyMode, WorkspaceGrant } from '@shared/companion'
import { DAILY_NOTE_LIMIT, dailyChatDraft, dailySourceId, discoverDailyTodos, mentionsDailyTodo, parseDailyMemo, rankDailySources, type DailyMemo, type DailyTodoDiscovery } from '@/lib/dailyTodo'
import { editMarkdownTask, setMarkdownTask, type TodoTaskEdit, type TodoTaskStatus } from '@shared/todoMarkdown'

const emptyDiscovery: DailyTodoDiscovery = { sources: [], matched: false, errors: [], limited: false }

export function useDailyTodo({ api, workspaces, messages, workspaceId, active, busy }: {
  api: CompanionAPI | undefined; workspaces: WorkspaceGrant[]; messages: CompanionMessage[]
  workspaceId: string; active: boolean; busy: boolean
}) {
  const key = 'dailyworkmate.dailyTodo.v1:' + (workspaceId || 'personal')
  const [stored, setStored] = useState<{ key: string; value: DailyMemo } | null>(null)
  const [storageError, setStorageError] = useState('')
  const memo = stored?.key === key ? stored.value : undefined
  const [discovery, setDiscovery] = useState({ identity: '', value: emptyDiscovery })
  const [reading, setReading] = useState({ id: '', content: '', revision: '', error: '', loading: false })
  const [operation, setOperation] = useState<'' | 'save' | 'copy' | 'copyUnfinished'>('')
  const [writeError, setWriteError] = useState('')
  const [copiedPath, setCopiedPath] = useState('')
  const mutation = useRef(0)
  const operating = useRef(false)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  // Snapshot refreshes create new arrays. Only real authorization changes restart discovery.
  const grantsIdentity = JSON.stringify(workspaces.map(({ id, name, path, writable }) => ({ id, name, path, writable })))
  const grants = useMemo<WorkspaceGrant[]>(() => JSON.parse(grantsIdentity), [grantsIdentity])
  const found = discovery.identity === grantsIdentity ? discovery.value : emptyDiscovery
  const sources = rankDailySources(found.sources, workspaceId)
  const source = memo?.sourceId === 'personal' ? undefined : sources.find(item => item.id === memo?.sourceId) || sources[0]
  const writable = !source || grants.some(grant => grant.id === source.workspaceId && grant.writable)
  const context = key + grantsIdentity + (source?.id || '')
  const currentContext = useRef(context)
  currentContext.current = context
  const mentioned = useMemo(() => messages.some(message => mentionsDailyTodo(message.content)), [messages])
  const draft = useMemo(() => busy ? '' : dailyChatDraft(messages), [messages, busy])

  useEffect(() => {
    try { setStored({ key, value: parseDailyMemo(localStorage.getItem(key)) }); setStorageError('') }
    catch (error) { setStored({ key, value: { enabled: false, text: '' } }); setStorageError(String(error)); console.warn('[DailyTodo] Read note:', error) }
  }, [key])

  const save = useCallback((value: DailyMemo) => {
    setStored({ key, value })
    try { localStorage.setItem(key, JSON.stringify(value)); setStorageError('') }
    catch (error) { setStorageError(String(error)); console.warn('[DailyTodo] Save note:', error) }
  }, [key])

  useEffect(() => {
    if (!memo || !mentioned || memo.enabled) return
    save({ ...memo, enabled: true })
  }, [mentioned, memo, save])

  useEffect(() => {
    // Keep the completed plan across new conversations and restarts. Manual edits always win.
    if (!memo || memo.edited || !draft || draft === memo.text) return
    save({ ...memo, enabled: true, text: draft })
  }, [draft, memo, save])

  useEffect(() => {
    if (!api || !active) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const scan = async () => {
      setLoading(true)
      const value = await discoverDailyTodos(api, grants, () => cancelled)
      if (cancelled) return
      setDiscovery({ identity: grantsIdentity, value }); setLoading(false)
      timer = setTimeout(() => void scan(), 15000)
    }
    void scan()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, active, grants, grantsIdentity, revision])

  useEffect(() => {
    if (!api || !active || !source || operation) return
    const { id, workspaceId, relativePath } = source
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const read = async () => {
      const generation = mutation.current
      setReading(current => current.id === id ? { ...current, loading: true } : { id, content: '', revision: '', error: '', loading: true })
      try {
        const document = await api.readTodo(workspaceId, relativePath)
        if (!cancelled && generation === mutation.current) setReading({ id, ...document, error: '', loading: false })
      } catch (error) {
        if (!cancelled && generation === mutation.current) setReading(current => ({ ...current, id, error: String(error), loading: false }))
      }
      if (!cancelled) timer = setTimeout(() => void read(), 5000)
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, active, source?.id, grantsIdentity, revision, operation])

  const personal = memo?.text || ''
  const content = source ? (reading.id === source.id ? reading.content : '') : memo?.edited ? personal : personal || draft
  const changeTask = async (line: number, status: TodoTaskStatus) => {
    if (operating.current || !writable) return
    setWriteError(''); setCopiedPath('')
    if (!source) {
      try { save({ enabled: true, text: setMarkdownTask(content, line, status), sourceId: 'personal', edited: true }) }
      catch (error) { setWriteError(String(error)) }
      return
    }
    if (!api || reading.id !== source.id || !reading.revision) return
    operating.current = true; mutation.current++; setOperation('save')
    try {
      const document = await api.setTodoTask(source.workspaceId, source.relativePath, { revision: reading.revision, line, status })
      if (currentContext.current === context) setReading({ id: source.id, ...document, error: '', loading: false })
    } catch (error) {
      console.warn('[DailyTodo] Save task:', error)
      if (currentContext.current === context) setWriteError(String(error))
    } finally { operating.current = false; setOperation(''); setRevision(value => value + 1) }
  }
  const editTask = async (edit: TodoTaskEdit, expectedContent: string): Promise<boolean> => {
    if (operating.current || !writable) return false
    setWriteError(''); setCopiedPath('')
    if (content !== expectedContent) {
      setWriteError('便签已更新，请取消并重新打开编辑，保留需要的修改。 / The note changed; cancel and reopen the editor before retrying.')
      return false
    }
    if (!source) {
      try {
        const text = editMarkdownTask(content, edit)
        if (text.length > DAILY_NOTE_LIMIT) throw new Error('便签已达到 20000 字符上限。 / This note exceeds the 20000 character limit.')
        save({ enabled: true, text, sourceId: 'personal', edited: true })
        return true
      } catch (error) { setWriteError(String(error)); return false }
    }
    if (!api || reading.id !== source.id || !reading.revision || reading.error) return false
    operating.current = true; mutation.current++; setOperation('save')
    try {
      const document = await api.editTodoTask(source.workspaceId, source.relativePath, { revision: reading.revision, edit })
      if (currentContext.current !== context) return false
      setReading({ id: source.id, ...document, error: '', loading: false })
      return true
    } catch (error) {
      console.warn('[DailyTodo] Edit task:', error)
      if (currentContext.current === context) setWriteError(String(error))
      return false
    } finally { operating.current = false; setOperation(''); setRevision(value => value + 1) }
  }
  const copyToday = async (mode: TodoCopyMode = 'all') => {
    if (!source || !api || !writable || operating.current) return
    operating.current = true; mutation.current++; setOperation(mode === 'unfinished' ? 'copyUnfinished' : 'copy'); setWriteError(''); setCopiedPath('')
    try {
      const result = await api.copyTodoToday(source.workspaceId, source.relativePath, mode)
      if (currentContext.current !== context) return
      const created = { ...source, relativePath: result.relativePath, id: dailySourceId(source.workspaceId, result.relativePath) }
      setDiscovery(current => ({ identity: grantsIdentity, value: { ...current.value, matched: true,
        sources: [...current.value.sources.filter(item => item.id !== created.id), created] } }))
      setReading({ id: created.id, ...result.document, error: '', loading: false })
      save({ enabled: true, text: personal, edited: memo?.edited, sourceId: created.id })
      setCopiedPath(result.relativePath)
    } catch (error) {
      console.warn('[DailyTodo] Copy today:', error)
      if (currentContext.current === context) setWriteError(String(error))
    } finally { operating.current = false; setOperation(''); setRevision(value => value + 1) }
  }
  return {
    visible: mentioned || !!memo?.enabled || found.matched,
    sources, source, content, personal, draft, writable, operation, writeError, copiedPath, changeTask, editTask, copyToday,
    identity: context,
    ready: !source || reading.id === source.id && !!reading.revision && !reading.error,
    clearWriteError: () => setWriteError(''),
    loading: loading || (!!source && (reading.id !== source.id || reading.loading)),
    error: source && reading.id === source.id ? reading.error : '',
    discoveryErrors: found.errors, limited: found.limited, storageError,
    refresh: () => setRevision(value => value + 1),
    select: (sourceId: string) => { setWriteError(''); setCopiedPath(''); save({ enabled: true, text: personal, edited: memo?.edited, sourceId }) },
    edit: (text: string) => save({ enabled: true, text, sourceId: 'personal', edited: true }),
    fromChat: !source && !memo?.edited && !!(personal || draft),
  }
}

export type DailyTodoModel = ReturnType<typeof useDailyTodo>
