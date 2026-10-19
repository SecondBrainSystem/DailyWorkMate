import { isFeatureMode, type FeatureMode } from '../../../shared/modelFeatures.ts'
import type { AgentTool } from '../../../shared/companion'
import { isTranslationTarget, type TranslationTarget } from './translation.ts'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'text'
  content: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  status?: 'stopped' | 'error'
  error?: string
  tools?: AgentTool[]
  toolStatus?: 'none' | 'used'
  model?: string
  retryOf?: string
  attachments?: ChatAttachment[]
}

export interface PersistedChatState {
  messages: ChatMessage[]
  model: string
  promptId: string
  vision: FeatureMode
  thinking: FeatureMode
  conversationId?: string
  createdAt?: number
  savedAt?: number
  draft?: string
  draftAttachments?: ChatAttachment[]
  systemPrompt?: string
  agentSessionId?: string
  agentWorkspaceId?: string
  agentGroupId?: string
  agentWorkspaceIds?: string[]
  agentAccessScope?: 'group' | 'folder'
  agentRelativePath?: string
  agentWorkspaceAccess?: string
  /** Workspace chats run in OpenCode v2 unless Claude Code or chat only was chosen. */
  agentEngine?: 'claude' | 'chat'
  /** Target language of a translation task conversation. */
  translationTarget?: TranslationTarget
  /** Set only in the localStorage backup: images it left out, restored from IndexedDB history by id. */
  omittedImageIds?: string[]
}

export const CHAT_STORAGE_KEY = 'dailyworkmate.chat.workspace.v1'
const MAX_PERSISTED_CHAT_CHARS = 3_000_000

export function validAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as ChatAttachment
  return typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.mimeType === 'string' && typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
    && (item.kind === 'image' || item.kind === 'text') && typeof item.content === 'string'
    && (item.kind !== 'image' || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(item.content))
}

export function normalizeChatWorkspace(parsed: unknown): PersistedChatState {
  const fallback: PersistedChatState = { messages: [], model: '', promptId: '', vision: 'auto', thinking: 'auto' }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  const input = parsed as Record<string, unknown>
  const messages = Array.isArray(input.messages) ? input.messages.flatMap((message: unknown) => {
    if (!message || typeof message !== 'object') return []
    const item = message as ChatMessage
    if (typeof item.id !== 'string' || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return []
    // An unfinished empty placeholder must not show a permanent spinner after restart.
    const status = item.status === 'stopped' || item.status === 'error' ? item.status : undefined
    if (item.role === 'assistant' && !item.content && !item.reasoning && !status && !item.error && !item.tools?.length) return []
    return [{
      id: item.id, role: item.role, content: item.content,
      ...(item.role === 'assistant' && typeof item.model === 'string' && item.model.trim() && item.model.length <= 300 && !/[\u0000-\u001f\u007f]/.test(item.model) ? { model: item.model } : {}),
      ...(item.role === 'assistant' && typeof item.retryOf === 'string' && item.retryOf.trim() && item.retryOf.length <= 80 && !/[\u0000-\u001f\u007f]/.test(item.retryOf) ? { retryOf: item.retryOf } : {}),
      ...(status ? { status } : {}),
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
      ...(item.toolStatus === 'none' || item.toolStatus === 'used' ? { toolStatus: item.toolStatus } : {}),
      ...(Array.isArray(item.tools) ? { tools: item.tools.filter(tool => tool && ['id', 'name', 'status', 'title'].every(key => typeof tool[key as keyof AgentTool] === 'string')).slice(-80).map(({id, name, status, title}) => ({id, name, status, title})) } : {}),
      ...(typeof item.reasoning === 'string' ? { reasoning: item.reasoning } : {}),
      ...(Array.isArray(item.attachments) ? { attachments: item.attachments.filter(validAttachment) } : {}),
    }]
  }) : []
  return {
    messages,
    model: typeof input.model === 'string' ? input.model : '',
    promptId: typeof input.promptId === 'string' ? input.promptId : '',
    vision: isFeatureMode(input.vision) ? input.vision : 'auto',
    thinking: isFeatureMode(input.thinking) ? input.thinking : 'auto',
    ...(typeof input.conversationId === 'string' && input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? { createdAt: input.createdAt } : {}),
    ...(typeof input.savedAt === 'number' && Number.isFinite(input.savedAt) ? { savedAt: input.savedAt } : {}),
    ...(typeof input.draft === 'string' ? { draft: input.draft } : {}),
    ...(Array.isArray(input.draftAttachments) ? { draftAttachments: input.draftAttachments.filter(validAttachment) } : {}),
    ...(typeof input.systemPrompt === 'string' ? { systemPrompt: input.systemPrompt } : {}),
    ...(typeof input.agentSessionId === 'string' ? { agentSessionId: input.agentSessionId } : {}),
    ...(typeof input.agentWorkspaceId === 'string' ? { agentWorkspaceId: input.agentWorkspaceId } : {}),
    ...(typeof input.agentGroupId === 'string' ? { agentGroupId: input.agentGroupId } : {}),
    ...(Array.isArray(input.agentWorkspaceIds) ? { agentWorkspaceIds: input.agentWorkspaceIds.filter((id): id is string => typeof id === 'string').slice(0, 32) } : {}),
    ...(input.agentAccessScope === 'group' || input.agentAccessScope === 'folder' ? { agentAccessScope: input.agentAccessScope } : {}),
    ...(typeof input.agentRelativePath === 'string' ? { agentRelativePath: input.agentRelativePath.slice(0, 4096) } : {}),
    ...(typeof input.agentWorkspaceAccess === 'string' ? { agentWorkspaceAccess: input.agentWorkspaceAccess.slice(0, 150000) } : {}),
    ...(input.agentEngine === 'claude' || input.agentEngine === 'chat' ? { agentEngine: input.agentEngine } : {}),
    ...(isTranslationTarget(input.translationTarget) ? { translationTarget: input.translationTarget } : {}),
    ...(Array.isArray(input.omittedImageIds) && input.omittedImageIds.length ? { omittedImageIds: input.omittedImageIds.filter((id): id is string => typeof id === 'string').slice(0, 1000) } : {}),
  }
}

const imagesOf = (items: ChatAttachment[] | undefined) => (items || []).filter(item => item.kind === 'image')
const textOf = (items: ChatAttachment[] | undefined) => items?.filter(item => item.kind !== 'image')

/**
 * The synchronous localStorage backup is written on the UI thread after every pause in typing, so it
 * leaves out image data URLs (up to 20 MB each). IndexedDB history keeps them; the backup records their ids.
 */
export function chatStateBackup(state: PersistedChatState): PersistedChatState {
  const omittedImageIds = [...state.messages.flatMap(message => imagesOf(message.attachments)), ...imagesOf(state.draftAttachments)].map(item => item.id)
  if (!omittedImageIds.length) return state
  return {
    ...state,
    messages: state.messages.map(message => message.attachments ? { ...message, attachments: textOf(message.attachments) } : message),
    ...(state.draftAttachments ? { draftAttachments: textOf(state.draftAttachments) } : {}),
    omittedImageIds,
  }
}

/** Puts images left out of a backup back in their original order, taking them from the full history copy. */
export function restoreOmittedImages(backup: PersistedChatState, source: PersistedChatState | undefined): PersistedChatState {
  const { omittedImageIds = [], ...rest } = backup
  if (!omittedImageIds.length) return rest
  const omitted = new Set(omittedImageIds)
  const merge = (kept: ChatAttachment[] | undefined, full: ChatAttachment[] | undefined) => {
    if (!imagesOf(full).some(item => omitted.has(item.id))) return kept
    const keptById = new Map((kept || []).map(item => [item.id, item]))
    const ordered = (full || []).flatMap(item => keptById.get(item.id) ?? (item.kind === 'image' && omitted.has(item.id) ? [item] : []))
    return [...ordered, ...(kept || []).filter(item => !ordered.some(other => other.id === item.id))]
  }
  const fullMessages = new Map((source?.messages || []).map(message => [message.id, message]))
  const messages = rest.messages.map(message => {
    const attachments = merge(message.attachments, fullMessages.get(message.id)?.attachments)
    return attachments === message.attachments ? message : { ...message, attachments }
  })
  const draftAttachments = merge(rest.draftAttachments, source?.draftAttachments)
  const restored = { ...rest, messages, ...(draftAttachments ? { draftAttachments } : {}) }
  const found = [...messages.flatMap(message => imagesOf(message.attachments)), ...imagesOf(draftAttachments)].filter(item => omitted.has(item.id)).length
  if (found < omitted.size) console.warn(`[Chat] ${omitted.size - found} image attachment(s) were not in saved history and could not be restored`)
  return restored
}

export function loadPersistedChatState(storage: Pick<Storage, 'getItem'> = localStorage): PersistedChatState {
  try {
    const raw = storage.getItem(CHAT_STORAGE_KEY)
    return normalizeChatWorkspace(raw ? JSON.parse(raw) : undefined)
  } catch (error) {
    console.warn('[Chat] Could not restore chat workspace:', error instanceof Error ? error.name : 'invalid data')
    return normalizeChatWorkspace(undefined)
  }
}

/**
 * Writes the synchronous backup (without image data, see chatStateBackup). When it cannot be written, the
 * previous backup stays: it is older than IndexedDB history, so startup only uses it if history was lost too.
 */
export function persistChatState(state: PersistedChatState, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    const serialized = JSON.stringify(chatStateBackup(state))
    if (serialized.length > MAX_PERSISTED_CHAT_CHARS) throw new Error('ChatStorageLimit')
    storage.setItem(CHAT_STORAGE_KEY, serialized)
    return true
  } catch (error) {
    console.warn('[Chat] Could not update the chat backup; keeping the previous one:', error instanceof Error ? error.message : 'storage unavailable')
    return false
  }
}
