import { normalizeChatWorkspace, restoreOmittedImages, type PersistedChatState } from './chatWorkspace.ts'

export const CHAT_HISTORY_DB = 'dailyworkmate.chat.history.v1'

export interface ChatConversation extends PersistedChatState {
  conversationId: string
  createdAt: number
  savedAt: number
}

export interface ChatHistorySummary {
  id: string
  title: string
  preview: string
  model: string
  promptId: string
  messageCount: number
  updatedAt: number
}

export function createConversation(state: PersistedChatState, now = Date.now()): ChatConversation {
  const normalized = normalizeChatWorkspace(state)
  return {
    ...normalized,
    conversationId: normalized.conversationId || crypto.randomUUID(),
    createdAt: normalized.createdAt ?? now,
    savedAt: now,
  }
}

export function conversationSummary(state: ChatConversation): ChatHistorySummary | undefined {
  if (!state.messages.length && !state.draft?.trim() && !state.draftAttachments?.length) return undefined
  const first = state.messages.find(message => message.role === 'user')
  const title = first?.content || first?.attachments?.[0]?.name || state.draft || state.draftAttachments?.[0]?.name || ''
  const last = state.messages[state.messages.length - 1]
  return {
    id: state.conversationId,
    title: title.replace(/\s+/g, ' ').trim().slice(0, 80),
    preview: (last?.content || last?.reasoning || state.draft || '').replace(/\s+/g, ' ').slice(0, 140),
    model: state.model,
    promptId: state.promptId,
    messageCount: state.messages.length,
    updatedAt: state.savedAt,
  }
}

export function updateHistorySummaries(items: ChatHistorySummary[], entry: ChatConversation): ChatHistorySummary[] {
  const remaining = items.filter(item => item.id !== entry.conversationId)
  const summary = conversationSummary(entry)
  return (summary ? [...remaining, summary] : remaining).sort((left, right) => right.updatedAt - left.updatedAt)
}

function validSummary(value: unknown): value is ChatHistorySummary {
  if (!value || typeof value !== 'object') return false
  const item = value as ChatHistorySummary
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.preview === 'string'
    && typeof item.model === 'string' && Number.isSafeInteger(item.messageCount) && item.messageCount >= 0
    && typeof item.updatedAt === 'number' && Number.isFinite(new Date(item.updatedAt).getTime())
}

function readConversation(value: unknown): ChatConversation | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || !Array.isArray((value as ChatConversation).messages)) throw new Error('Invalid chat history messages')
  const state = normalizeChatWorkspace(value)
  if (!state.conversationId || state.createdAt === undefined || state.savedAt === undefined) throw new Error('Invalid chat history record')
  return { ...state, conversationId: state.conversationId, createdAt: state.createdAt, savedAt: state.savedAt }
}

/** Separate summary and message stores keep listing history cheap, even with image attachments. */
export class ChatHistoryStorage {
  private database?: Promise<IDBDatabase>
  private writes: Promise<unknown> = Promise.resolve()
  private readonly databaseName: string
  constructor(databaseName = CHAT_HISTORY_DB) { this.databaseName = databaseName }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1)
      let blocked = false
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('conversations', { keyPath: 'conversationId' })
        db.createObjectStore('summaries', { keyPath: 'id' })
        db.createObjectStore('metadata')
      }
      request.onerror = () => reject(request.error || new Error('Unable to open chat history'))
      request.onblocked = () => { blocked = true; reject(new Error('Chat history is open in another app window')) }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close(); this.database = undefined }
        resolve(db)
      }
    }).catch(error => { this.database = undefined; throw error })
    return this.database
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work)
    // The caller receives the rejection; future writes must remain retryable.
    this.writes = result.catch(() => undefined)
    return result
  }

  private async read(store: string, key: string): Promise<unknown> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly')
      const request = transaction.objectStore(store).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error || new Error('Chat history read was aborted'))
    })
  }

  private async commit(entries: ChatConversation[], activeId?: string, deleteId?: string): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations', 'summaries', 'metadata'], 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error || new Error('Chat history write was aborted'))
      transaction.onerror = () => reject(transaction.error || new Error('Unable to save chat history'))
      const conversations = transaction.objectStore('conversations')
      const summaries = transaction.objectStore('summaries')
      for (const entry of entries) {
        const summary = conversationSummary(entry)
        if (summary) { conversations.put(entry); summaries.put(summary) }
        else { conversations.delete(entry.conversationId); summaries.delete(entry.conversationId) }
      }
      if (deleteId) { conversations.delete(deleteId); summaries.delete(deleteId) }
      const metadata = transaction.objectStore('metadata')
      for (const entry of entries) {
        if (entry.conversationId !== deleteId) metadata.put(entry.conversationId, 'scope:' + entry.promptId)
      }
      if (activeId) metadata.put(activeId, 'activeId')
    })
  }

  initialize(legacy: PersistedChatState, additionalLegacy: PersistedChatState[] = []): Promise<ChatConversation> {
    return this.enqueue(async () => {
      const activeId = await this.read('metadata', 'activeId')
      const active = typeof activeId === 'string' ? readConversation(await this.read('conversations', activeId)) : undefined
      if (active) {
        // Recover the last synchronous backup only for the same conversation, never revive a deleted one.
        if (legacy.conversationId === active.conversationId && (legacy.savedAt || 0) > active.savedAt) {
          const recovered = createConversation(restoreOmittedImages(legacy, active), legacy.savedAt)
          await this.commit([recovered], recovered.conversationId)
          return recovered
        }
        return active
      }
      const entry = createConversation(activeId ? normalizeChatWorkspace(undefined) : restoreOmittedImages(legacy, undefined))
      await this.commit([...(activeId ? [] : additionalLegacy.map(state => createConversation(state))), entry], entry.conversationId)
      return entry
    })
  }

  async list(): Promise<ChatHistorySummary[]> {
    await this.writes
    const db = await this.open()
    const items = await new Promise<ChatHistorySummary[]>((resolve, reject) => {
      const transaction = db.transaction('summaries', 'readonly')
      const request = transaction.objectStore('summaries').getAll()
      request.onsuccess = () => resolve(request.result.filter(validSummary).sort((a, b) => b.updatedAt - a.updatedAt))
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error || new Error('Chat history list was aborted'))
    })
    // Older databases have unscoped summaries; derive the scope from the full record.
    return Promise.all(items.map(async item => typeof item.promptId === 'string' ? item : {
      ...item, promptId: (await this.get(item.id))?.promptId || '',
    }))
  }

  async activeForScope(promptId: string): Promise<ChatConversation | undefined> {
    await this.writes
    const id = await this.read('metadata', 'scope:' + promptId)
    const entry = typeof id === 'string' ? await this.get(id) : undefined
    if (entry?.promptId === promptId) return entry
    const latest = (await this.list()).find(item => item.promptId === promptId)
    return latest ? this.get(latest.id) : undefined
  }

  /** Every stored conversation, including ones without messages (which have no summary). */
  async conversations(): Promise<ChatConversation[]> {
    await this.writes
    const db = await this.open()
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = db.transaction('conversations', 'readonly')
      const request = transaction.objectStore('conversations').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error || new Error('Chat history read was aborted'))
    })
    return records.map(readConversation).filter((entry): entry is ChatConversation => !!entry)
  }

  async get(id: string): Promise<ChatConversation | undefined> {
    await this.writes
    return readConversation(await this.read('conversations', id))
  }

  save(entry: ChatConversation): Promise<void> {
    return this.enqueue(() => this.commit([entry]))
  }

  transition(next: ChatConversation, previous?: ChatConversation, deleteId?: string): Promise<void> {
    return this.enqueue(() => this.commit(previous ? [previous, next] : [next], next.conversationId, deleteId))
  }

  remove(id: string): Promise<void> {
    return this.enqueue(() => this.commit([], undefined, id))
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.open()
      await new Promise<void>((resolve, reject) => {
        const stores = ['conversations', 'summaries', 'metadata']
        const transaction = db.transaction(stores, 'readwrite')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error || new Error('Chat history reset was aborted'))
        transaction.onerror = () => reject(transaction.error || new Error('Unable to clear chat history'))
        for (const store of stores) transaction.objectStore(store).clear()
      })
    })
  }
}

export const chatHistoryStorage = new ChatHistoryStorage()
