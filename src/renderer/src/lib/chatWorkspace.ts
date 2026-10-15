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
  }
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

/** Never drop attachment content silently: warn and remove stale history if the snapshot cannot be saved. */
export function persistChatState(state: PersistedChatState, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): boolean {
  try {
    const serialized = JSON.stringify(state)
    if (serialized.length > MAX_PERSISTED_CHAT_CHARS) throw new Error('ChatStorageLimit')
    storage.setItem(CHAT_STORAGE_KEY, serialized)
    return true
  } catch (error) {
    console.warn('[Chat] Could not save chat workspace:', error instanceof Error ? error.name : 'storage unavailable')
    try { storage.removeItem(CHAT_STORAGE_KEY) } catch (removeError) {
      console.warn('[Chat] Could not remove stale chat workspace:', removeError instanceof Error ? removeError.name : 'storage unavailable')
    }
    return false
  }
}
