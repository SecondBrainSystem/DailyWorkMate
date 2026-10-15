import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Bot,
  Copy,
  FileText,
  History,
  Image as ImageIcon,
  Languages,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ModelCheckBadge } from '@/components/ui/model-check-badge'
import { clearPreverifyCache, useModelPreverification } from '@/lib/modelPreverify'
import { LoadError } from '@/components/ui/load-error'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { AppConfig, SystemPrompt } from '@/types/electron'
import { cn } from '@/lib/utils'
import { CHAT_BUILTIN_PROMPTS } from '@/lib/chatPrompts'
import { TRANSLATION_TARGETS, lastTranslationTarget, rememberTranslationTarget, withTranslationTarget, type TranslationTarget } from '@/lib/translation'
import { toChatApiMessages } from '@/lib/chatRequest'
import { ModelFeatureControls } from '@/components/proxy/ModelFeatureControls'
import { ErrorText } from '@/components/ui/error-text'
import { ChatWorkspaceAccess, WorkspaceAgentStatus } from '@/components/chat/ChatWorkspaceAccess'
import { useWorkspaceAgent } from '@/hooks/useWorkspaceAgent'
import { chatWorkspaceIdentity, workspaceSelectionFromState, workspaceStateFields, type ChatWorkspaceSelection } from '@/lib/workspaceAgent'
import type { CompanionSnapshot } from '@shared/companion'
import { MessageMarkdown } from '@/components/chat/MessageMarkdown'
import { toast } from '@/hooks/use-toast'
import { ChatHistoryDialog } from '@/components/chat/ChatHistoryDialog'
import { type ChatAttachment, type ChatMessage, type PersistedChatState, loadPersistedChatState, persistChatState } from '@/lib/chatWorkspace'
import { chatHistoryStorage, createConversation, updateHistorySummaries, type ChatConversation, type ChatHistorySummary } from '@/lib/chatHistory'
import {
  type ChatApiMessage,
  createProxyHeaders,
  readChatCompletionStream,
  resolveLocalProxyBaseUrl,
} from '@/lib/chatClient'

interface ModelListResponse {
  data?: Array<{ id: string; owned_by?: string }>
}

const TASKS_COLLAPSED_KEY = 'dailyworkmate.chat.tasksCollapsed'
const readTasksCollapsed = () => { try { return localStorage.getItem(TASKS_COLLAPSED_KEY) === 'true' } catch { return false } }
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.hpp,.go,.rs,.sh,.ps1,.sql,.toml,.ini,.log'
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx',
  'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sh', 'ps1', 'sql', 'toml', 'ini', 'log',
])

function createId(): string {
  return crypto.randomUUID()
}

function isTextFile(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  return file.type.startsWith('text/')
    || ['application/json', 'application/xml', 'application/javascript'].includes(file.type)
    || TEXT_EXTENSIONS.has(extension)
}

function readFile(file: File, mode: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error(`Unable to read ${file.name}`))
    if (mode === 'dataUrl') reader.readAsDataURL(file)
    else reader.readAsText(file)
  })
}

async function createAttachment(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith('image/')) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error(`UNSUPPORTED_FILE:${file.name}`)
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`IMAGE_TOO_LARGE:${file.name}`)
    return {
      id: createId(), name: file.name, mimeType: file.type, size: file.size,
      kind: 'image', content: await readFile(file, 'dataUrl'),
    }
  }
  if (!isTextFile(file)) throw new Error(`UNSUPPORTED_FILE:${file.name}`)
  if (file.size > MAX_TEXT_BYTES) throw new Error(`TEXT_TOO_LARGE:${file.name}`)
  return {
    id: createId(), name: file.name, mimeType: file.type || 'text/plain', size: file.size,
    kind: 'text', content: await readFile(file, 'text'),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}


export function Chat() {
  const { t, i18n } = useTranslation()
  const chinese = i18n.language.startsWith('zh')
  const [restoredState] = useState(() => loadPersistedChatState())
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<CompanionSnapshot | null>(null)
  const [agentState, setAgentState] = useState(() => ({ selection: workspaceSelectionFromState(restoredState), sessionId: restoredState.agentSessionId || '', access: restoredState.agentWorkspaceAccess || '' }))
  const workspaceAgent = useWorkspaceAgent()
  const [messages, setMessages] = useState<ChatMessage[]>(restoredState.messages)
  const [attachments, setAttachments] = useState<ChatAttachment[]>(restoredState.draftAttachments || [])
  const [input, setInput] = useState(restoredState.draft || '')
  const [models, setModels] = useState<Array<{ id: string; owner: string }>>([])
  const [model, setModel] = useState(restoredState.model)
  const [prompts, setPrompts] = useState<SystemPrompt[]>(CHAT_BUILTIN_PROMPTS)
  const [promptId, setPromptId] = useState(restoredState.promptId)
  const [features, setFeatures] = useState({ vision: restoredState.vision, thinking: restoredState.thinking })
  const [savedSystemPrompt, setSavedSystemPrompt] = useState(restoredState.systemPrompt)
  const [translationTarget, setTranslationTarget] = useState<TranslationTarget>(restoredState.translationTarget ?? lastTranslationTarget())
  const [tasksCollapsed, setTasksCollapsed] = useState(readTasksCollapsed)
  const toggleTasks = (collapsed: boolean) => { setTasksCollapsed(collapsed); try { localStorage.setItem(TASKS_COLLAPSED_KEY, String(collapsed)) } catch { /* per-device convenience only */ } }
  const [conversation, setConversation] = useState(() => ({ id: restoredState.conversationId || createId(), createdAt: restoredState.createdAt || Date.now() }))
  const [historyReady, setHistoryReady] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyItems, setHistoryItems] = useState<ChatHistorySummary[]>([])
  const [storageWarning, setStorageWarning] = useState(false)
  const [isReadingFiles, setIsReadingFiles] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<SystemPrompt | null>(null)
  const [isSavingPrompt, setIsSavingPrompt] = useState(false)
  const [promptEditorError, setPromptEditorError] = useState('')
  const [proxyRunning, setProxyRunning] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [isLoadingModels, setIsLoadingModels] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState('')
  const [modelNotice, setModelNotice] = useState('')
  // Kept apart from the composer error so a failed model load shows one message, not two.
  const [modelsError, setModelsError] = useState('')
  const [verifyingModel, setVerifyingModel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const workspaceVersionRef = useRef(0)
  const fileReadRef = useRef(false)
  const persistTimerRef = useRef<number | undefined>(undefined)
  const historyBusyRef = useRef(false)
  const historyReadyRef = useRef(false)
  const mountedRef = useRef(true)
  const initializeVersionRef = useRef(0)
  const snapshotRef = useRef<PersistedChatState>(restoredState)
  const conversationModelRef = useRef(restoredState.model)
  const visionEnabled = features.vision === 'enabled' || (features.vision === 'auto' && config?.modelFeatureDefaults?.vision !== 'disabled')

  const selectedPrompt = useMemo(
    () => prompts.find(prompt => prompt.id === promptId),
    [promptId, prompts],
  )
  const effectiveSystemPrompt = savedSystemPrompt ?? selectedPrompt?.prompt ?? ''
  const isTranslation = selectedPrompt?.type === 'translation'
  // Translation tasks send the chosen target language with the task prompt.
  const requestSystemPrompt = isTranslation ? withTranslationTarget(effectiveSystemPrompt, translationTarget) : effectiveSystemPrompt
  const modelAvailable = models.some(item => item.id === model)
  const canVerifyModel = modelAvailable || Boolean(model && conversationModelRef.current === model)
  // Checked in the background as soon as a listed model is selected, so sending does not wait for it.
  const preverify = useModelPreverification(model, modelAvailable && !isLoadingModels && proxyRunning)
  const modelPrechecked = preverify.model === model && preverify.status === 'ready'
  snapshotRef.current = {
    messages, model, promptId, ...features,
    conversationId: conversation.id, createdAt: conversation.createdAt,
    draft: input, draftAttachments: attachments, systemPrompt: effectiveSystemPrompt, translationTarget,
    ...workspaceStateFields(agentState.selection), agentSessionId: agentState.sessionId, agentWorkspaceAccess: agentState.access,
  }

  const applyConversation = (entry: ChatConversation) => {
    snapshotRef.current = entry
    conversationModelRef.current = entry.model
    setConversation({ id: entry.conversationId, createdAt: entry.createdAt })
    setMessages(entry.messages)
    setInput(entry.draft || '')
    setAttachments(entry.draftAttachments || [])
    setModel(current => entry.model || current)
    setPromptId(entry.promptId)
    setSavedSystemPrompt(entry.promptId ? prompts.find(prompt => prompt.id === entry.promptId)?.prompt ?? entry.systemPrompt : entry.systemPrompt)
    setFeatures({ vision: entry.vision, thinking: entry.thinking })
    setTranslationTarget(entry.translationTarget ?? lastTranslationTarget())
    setAgentState({ selection: workspaceSelectionFromState(entry), sessionId: entry.agentSessionId || '', access: entry.agentWorkspaceAccess || '' })
    workspaceAgent.reset()
    setError('')
    setModelNotice('')
    setIsDragging(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    persistChatState(entry)
  }

  const initializeHistory = async () => {
    const version = ++initializeVersionRef.current
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const entry = await chatHistoryStorage.initialize(restoredState)
      const items = await chatHistoryStorage.list()
      if (!mountedRef.current || initializeVersionRef.current !== version) return
      applyConversation(entry)
      setHistoryItems(items)
      historyReadyRef.current = true
      setHistoryReady(true)
    } catch (loadError) {
      console.warn('[Chat] History initialization failed:', loadError)
      if (mountedRef.current && initializeVersionRef.current === version) {
        setHistoryError(t('chat.history.loadFailed')); setStorageWarning(true)
        historyReadyRef.current = true; setHistoryReady(true)
      }
    } finally {
      if (mountedRef.current && initializeVersionRef.current === version) setHistoryLoading(false)
    }
  }

  const saveHistory = async (state: PersistedChatState) => {
    const entry = createConversation(state)
    persistChatState(entry)
    try {
      await chatHistoryStorage.save(entry)
      if (mountedRef.current) {
        setHistoryItems(current => updateHistorySummaries(current, entry))
        setStorageWarning(false)
      }
    } catch (saveError) {
      console.warn('[Chat] History save failed:', saveError)
      if (mountedRef.current) setStorageWarning(true)
    }
  }

  const loadWorkspace = useCallback(async () => {
    setIsLoadingModels(true)
    setError('')
    setModelsError('')
    try {
      const status = await window.electronAPI.proxy.getStatus()
      setProxyRunning(status.isRunning)

      const [nextConfig, storedPrompts] = await Promise.all([
        window.electronAPI.config.get(),
        window.electronAPI.prompts.getAll(),
      ])
      setConfig(nextConfig)

      const nextPrompts = storedPrompts.length > 0 ? storedPrompts : CHAT_BUILTIN_PROMPTS
      setPrompts(nextPrompts)

      if (!status.isRunning) {
        const providers = (await window.electronAPI.providers.getAll()).filter(provider => provider.enabled)
        const accounts = await window.electronAPI.accounts.getAll()
        const lists = await Promise.all(providers.filter(provider => accounts.some(account => account.providerId === provider.id && account.status === 'active')).map(async provider => (await window.electronAPI.providers.getEffectiveModels(provider.id)).map(entry => ({ id: entry.displayName, owner: provider.name }))))
        const catalogue = [...new Map(lists.flat().filter(entry => !entry.id.includes('*')).map(entry => [entry.id, entry])).values()]
        setModels(catalogue); setModel(current => current || catalogue[0]?.id || '')
        return
      }
      const response = await fetch(`${resolveLocalProxyBaseUrl(nextConfig)}/v1/models`, {
        headers: createProxyHeaders(nextConfig),
      })
      if (!response.ok) throw new Error(`${t('chat.errors.loadModels')} (HTTP ${response.status})`)
      const payload = await response.json() as ModelListResponse
      const nextModels = (payload.data || []).map(item => ({ id: item.id, owner: item.owned_by || '' }))
      setModels(nextModels)
      setModel(current => current || nextModels[0]?.id || '')
    } catch (loadError) {
      setModelsError(loadError instanceof Error ? loadError.message : t('chat.errors.loadModels'))
    } finally {
      setIsLoadingModels(false)
    }
  }, [t])

  useEffect(() => {
    void loadWorkspace()
    return window.electronAPI.proxy.onStatusChanged(status => setProxyRunning(status.isRunning))
  }, [loadWorkspace])

  useEffect(() => {
    mountedRef.current = true
    void initializeHistory()
    const saveBeforeClose = () => {
      if (historyReadyRef.current && !historyBusyRef.current) void saveHistory(snapshotRef.current)
    }
    window.addEventListener('beforeunload', saveBeforeClose)
    return () => {
      mountedRef.current = false
      initializeVersionRef.current += 1
      workspaceVersionRef.current += 1
      const controller = abortControllerRef.current
      abortControllerRef.current = null
      if (controller) snapshotRef.current = { ...snapshotRef.current, messages: snapshotRef.current.messages.map((item, index, all) => index === all.length - 1 && item.role === 'assistant' ? { ...item, status: 'stopped' } : item) }
      controller?.abort()
      window.clearTimeout(persistTimerRef.current)
      window.removeEventListener('beforeunload', saveBeforeClose)
      saveBeforeClose()
    }
  }, [])

  useEffect(() => {
    if (followOutputRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
  }, [messages])

  useEffect(() => {
    if (!historyReady || historyBusy) return
    persistTimerRef.current = window.setTimeout(() => {
      if (!historyBusyRef.current) void saveHistory(snapshotRef.current)
    }, 400)
    return () => window.clearTimeout(persistTimerRef.current)
  }, [messages, model, promptId, features, input, attachments, savedSystemPrompt, translationTarget, conversation, historyReady, historyBusy, agentState])

  const addFiles = async (files: FileList | File[]) => {
    if (!historyReadyRef.current || historyBusyRef.current || fileReadRef.current || abortControllerRef.current) return
    const version = workspaceVersionRef.current
    const incoming = Array.from(files)
    if (attachments.reduce((total, item) => total + item.size, 0) + incoming.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
      setError(t('chat.errors.attachmentsTooLarge'))
      return
    }
    fileReadRef.current = true
    setIsReadingFiles(true)
    setError('')
    const next: ChatAttachment[] = []
    for (const file of incoming) {
      if (version !== workspaceVersionRef.current) break
      if (!visionEnabled && file.type.startsWith('image/')) {
        setError(t('chat.errors.visionDisabled'))
        continue
      }
      try {
        next.push(await createAttachment(file))
      } catch (fileError) {
        if (version !== workspaceVersionRef.current) break
        const message = fileError instanceof Error ? fileError.message : ''
        if (message.startsWith('IMAGE_TOO_LARGE:')) setError(t('chat.errors.imageTooLarge', { name: file.name }))
        else if (message.startsWith('TEXT_TOO_LARGE:')) setError(t('chat.errors.fileTooLarge', { name: file.name }))
        else setError(t('chat.errors.unsupportedFile', { name: file.name }))
      }
    }
    if (version === workspaceVersionRef.current) {
      if (next.length > 0) setAttachments(current => [...current, ...next])
      setIsReadingFiles(false)
      fileReadRef.current = false
    }
  }

  const generateAssistant = async (history: ChatMessage[], forceNewSession = false) => {
    if (!canVerifyModel || !historyReadyRef.current || historyBusyRef.current || abortControllerRef.current || fileReadRef.current) return
    if (agentState.selection.workspaceId && history[history.length - 1]?.attachments?.some(file => file.kind === 'image')) {
      setError(chinese ? '工作区聊天暂不支持图片附件。请移除图片，或选择“不访问工作区”后发送。' : 'Workspace chat does not support image attachments yet. Remove the images or select “No workspace access”.')
      return
    }

    const assistantId = createId()
    setMessages([...history, { id: assistantId, role: 'assistant', content: '' }])
    setIsSending(true)

    const controller = new AbortController()
    abortControllerRef.current = controller
    let timeout: number | undefined
    let timedOut = false
    try {
      const activeConfig = await window.electronAPI.config.get()
      if (abortControllerRef.current !== controller) return
      setConfig(activeConfig)
      if (!(await window.electronAPI.proxy.getStatus()).isRunning && !(await window.electronAPI.proxy.start())) throw new Error(t('chat.errors.startProxy'))
      setProxyRunning(true)
      // Only surface the verifying state when the background check has not already passed.
      if (!modelPrechecked) setVerifyingModel(true)
      timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, (activeConfig.requestTimeout || 120000) * 2 + 10000)
      const verification = await fetch(`${resolveLocalProxyBaseUrl(activeConfig)}/v1/models/verify`, {
        method: 'POST', headers: createProxyHeaders(activeConfig),
        body: JSON.stringify({ model, recover: false }), signal: controller.signal,
      })
      const verified = await verification.json() as {
        model?: string; recovered?: boolean; skipped?: boolean; providerName?: string; reason?: string; error?: { message?: string }
      }
      if (!verification.ok || verified.model !== model || verified.recovered === true) {
        clearPreverifyCache(model)
        const reason = verified.error?.message || t('chat.history.modelUnavailable', { model })
        preverify.report(false, reason)
        throw new Error(reason)
      }
      if (abortControllerRef.current !== controller) return
      preverify.report(true, undefined, verified.skipped)
      const activeModel = model
      setVerifyingModel(false)
      if (agentState.selection.workspaceId) {
        window.clearTimeout(timeout)
        const grants = await window.electronAPI.companion.get()
        if (controller.signal.aborted) return
        setWorkspaceSnapshot(grants)
        const access = chatWorkspaceIdentity(grants, agentState.selection, activeModel, requestSystemPrompt)
        const resume = !forceNewSession && agentState.access === access ? agentState.sessionId : ''
        const dialogue = toChatApiMessages(history, false).map(message => ({ role: message.role as 'user' | 'assistant', content: String(message.content) }))
        const latest = dialogue[dialogue.length - 1]
        if (!latest || latest.role !== 'user') throw new Error('A workspace request requires a user message')
        await workspaceAgent.execute({
          ...agentState.selection, model: activeModel, prompt: latest.content, systemPrompt: requestSystemPrompt,
          sessionId: resume, history: dialogue.slice(0, -1),
        }, { signal: controller.signal, onUpdate: state => {
          if (abortControllerRef.current !== controller) return
          setAgentState(current => ({ ...current, sessionId: state.sessionId, access }))
          snapshotRef.current = { ...snapshotRef.current, agentSessionId: state.sessionId, agentWorkspaceAccess: access }
          setMessages(current => current.map(message => message.id === assistantId ? { ...message, content: state.text, tools: state.tools, toolStatus: state.tools.length ? 'used' : 'none' } : message))
        } })
        return
      }
      const resetTimeout = () => {
        window.clearTimeout(timeout)
        timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1000, activeConfig.requestTimeout || 60000))
      }
      resetTimeout()
      const sendImages = features.vision === 'enabled' || (features.vision === 'auto' && activeConfig.modelFeatureDefaults?.vision !== 'disabled')
      const apiMessages: ChatApiMessage[] = [
        ...(requestSystemPrompt ? [{ role: 'system' as const, content: requestSystemPrompt }] : []),
        ...toChatApiMessages(history, sendImages, features.vision === 'auto'),
      ]
      const response = await fetch(`${resolveLocalProxyBaseUrl(activeConfig)}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...createProxyHeaders(activeConfig), 'X-DailyWorkMate-Model-Selection': 'explicit' },
        body: JSON.stringify({
          model: activeModel, messages: apiMessages, stream: true,
          ...(features.vision === 'auto' ? {} : { enable_vision: features.vision === 'enabled' }),
          ...(features.thinking === 'auto' ? {} : { enable_thinking: features.thinking === 'enabled' }),
        }),
        signal: controller.signal,
      })

      await readChatCompletionStream(response, delta => {
        if (abortControllerRef.current !== controller) return
        setMessages(current => current.map(message => message.id === assistantId ? {
          ...message,
          content: message.content + (delta.content || ''),
          reasoning: (message.reasoning || '') + (delta.reasoning || ''),
        } : message))
      }, resetTimeout)
      preverify.report(true, undefined, verified.skipped)
    } catch (sendError) {
      if (abortControllerRef.current !== controller) return
      if (controller.signal.aborted && !timedOut) {
        setMessages(current => current.map(message => (
          message.id === assistantId ? { ...message, status: 'stopped' } : message
        )))
      } else {
        const message = timedOut ? t('chat.errors.timeout') : sendError instanceof Error ? sendError.message : t('chat.errors.send')
        preverify.report(false, message)
        setMessages(current => current.map(item => (
          item.id === assistantId ? { ...item, status: 'error', error: message } : item
        )))
      }
    } finally {
      window.clearTimeout(timeout)
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
        setIsSending(false)
        setVerifyingModel(false)
      }
    }
  }

  const sendMessage = async () => {
    const content = input.trim() || (attachments.length > 0 ? t('chat.defaultAttachmentPrompt') : '')
    if (!content || !canVerifyModel || !historyReadyRef.current || historyBusyRef.current || isLoadingModels || abortControllerRef.current || fileReadRef.current) return
    if (agentState.selection.workspaceId && attachments.some(file => file.kind === 'image')) {
      setError(chinese ? '工作区聊天暂不支持图片附件。请移除图片，或选择“不访问工作区”后发送。' : 'Workspace chat does not support image attachments yet. Remove the images or select “No workspace access”.')
      return
    }

    setError('')
    const userMessage: ChatMessage = {
      id: createId(), role: 'user', content, attachments: [...attachments],
    }
    const history = [...messages, userMessage]
    setInput('')
    setAttachments([])
    await generateAssistant(history)
  }

  const regenerateLastResponse = async () => {
    if (isSending || historyBusyRef.current || !historyReadyRef.current) return
    let assistantIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') {
        assistantIndex = index
        break
      }
    }
    if (assistantIndex < 0) return
    setError('')
    setAgentState(current => ({ ...current, sessionId: '' }))
    await generateAssistant(messages.slice(0, assistantIndex), true)
  }

  const editAndResend = (index: number) => {
    const message = messages[index]
    if (!message || message.role !== 'user' || isSending || historyBusyRef.current || !historyReadyRef.current) return
    setInput(message.content)
    setAttachments(message.attachments ? [...message.attachments] : [])
    setMessages(messages.slice(0, index))
    setAgentState(current => ({ ...current, sessionId: '' }))
    setError('')
  }

  const stopWorkspaceWork = () => {
    workspaceVersionRef.current += 1
    const controller = abortControllerRef.current
    if (controller) {
      const stopped = snapshotRef.current.messages.map((item, index, all) => index === all.length - 1 && item.role === 'assistant' ? { ...item, status: 'stopped' as const } : item)
      snapshotRef.current = { ...snapshotRef.current, messages: stopped }
      setMessages(stopped)
    }
    abortControllerRef.current = null
    controller?.abort()
    void workspaceAgent.cancel().catch(failure => console.error('[Chat] Could not stop workspace task:', failure))
    fileReadRef.current = false
    setIsReadingFiles(false)
    setIsSending(false)
    setVerifyingModel(false)
    window.clearTimeout(persistTimerRef.current)
  }

  const changeConversation = async (targetId?: string, clear = false, confirmed = false) => {
    if (!historyReadyRef.current || historyBusyRef.current) return
    if (targetId === conversation.id) { setHistoryOpen(false); return }
    if (clear && !confirmed && !window.confirm(t('chat.clearChat') + '?')) return
    historyBusyRef.current = true
    setHistoryBusy(true)
    setHistoryError('')
    stopWorkspaceWork()
    const previous = createConversation(snapshotRef.current)
    try {
      await workspaceAgent.cancel()
      const next = targetId ? await chatHistoryStorage.get(targetId) : createConversation({
        messages: [], model: previous.model, promptId: previous.promptId,
        vision: previous.vision, thinking: previous.thinking,
        systemPrompt: prompts.find(prompt => prompt.id === previous.promptId)?.prompt || '', draft: '', draftAttachments: [],
        ...workspaceStateFields(workspaceSelectionFromState(previous)),
      })
      if (!next) throw new Error('Conversation no longer exists')
      // Saving the previous chat and selecting/deleting the next one is one atomic transaction.
      await chatHistoryStorage.transition(next, clear ? undefined : previous, clear ? previous.conversationId : undefined)
      persistChatState(next)
      if (!mountedRef.current) return
      applyConversation(next)
      setHistoryItems(current => updateHistorySummaries(
        clear ? current.filter(item => item.id !== previous.conversationId) : updateHistorySummaries(current, previous), next,
      ))
      setStorageWarning(false)
      setHistoryOpen(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } catch (changeError) {
      console.warn('[Chat] Conversation switch failed:', changeError)
      if (mountedRef.current) {
        setHistoryError(t('chat.history.changeFailed'))
        if (!targetId) {
          applyConversation(createConversation({ messages: [], draft: previous.draft, draftAttachments: previous.draftAttachments, model: previous.model, promptId: previous.promptId, vision: previous.vision, thinking: previous.thinking, systemPrompt: prompts.find(prompt => prompt.id === previous.promptId)?.prompt || '', ...workspaceStateFields(workspaceSelectionFromState(previous)) }))
          setStorageWarning(true); setHistoryOpen(false); setError(t('chat.history.changeFailed'))
        } else setError(t('chat.history.changeFailed'))
      }
    } finally {
      historyBusyRef.current = false
      if (mountedRef.current) setHistoryBusy(false)
    }
  }

  const refreshHistory = async () => {
    if (!historyReadyRef.current) { await initializeHistory(); return }
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const items = await chatHistoryStorage.list()
      if (mountedRef.current) setHistoryItems(updateHistorySummaries(items, createConversation(snapshotRef.current)))
    } catch (loadError) {
      console.warn('[Chat] History list failed:', loadError)
      if (mountedRef.current) setHistoryError(t('chat.history.loadFailed'))
    } finally { if (mountedRef.current) setHistoryLoading(false) }
  }

  const deleteHistory = async (id: string) => {
    // History already presented its deletion confirmation.
    if (id === conversation.id) { await changeConversation(undefined, true, true); return }
    if (historyBusyRef.current) return
    historyBusyRef.current = true
    setHistoryBusy(true)
    setHistoryError('')
    try {
      await chatHistoryStorage.remove(id)
      if (mountedRef.current) setHistoryItems(current => current.filter(item => item.id !== id))
    } catch (deleteError) {
      console.warn('[Chat] History deletion failed:', deleteError)
      if (mountedRef.current) setHistoryError(t('chat.history.deleteFailed'))
    } finally {
      historyBusyRef.current = false
      if (mountedRef.current) setHistoryBusy(false)
    }
  }

  const choosePrompt = async (id: string) => {
    if (id === promptId || !historyReadyRef.current || historyBusyRef.current) return
    historyBusyRef.current = true
    setHistoryBusy(true)
    stopWorkspaceWork()
    const previous = createConversation(snapshotRef.current)
    try {
      await workspaceAgent.cancel()
      const next = await chatHistoryStorage.activeForScope(id) || createConversation({
        messages: [], model: previous.model, promptId: id,
        vision: previous.vision, thinking: previous.thinking,
        systemPrompt: prompts.find(prompt => prompt.id === id)?.prompt || '',
        ...workspaceStateFields(workspaceSelectionFromState(previous)),
      })
      await chatHistoryStorage.transition(next, previous)
      if (!mountedRef.current) return
      applyConversation({ ...next, systemPrompt: prompts.find(prompt => prompt.id === id)?.prompt || '' })
      setHistoryItems(current => updateHistorySummaries(updateHistorySummaries(current, previous), next))
      setStorageWarning(false)
    } catch (error) {
      console.warn('[Chat] Task switch failed:', error)
      if (mountedRef.current) {
        applyConversation(createConversation({ messages: [], model: previous.model, promptId: id, vision: previous.vision, thinking: previous.thinking, systemPrompt: prompts.find(prompt => prompt.id === id)?.prompt || '', ...workspaceStateFields(workspaceSelectionFromState(previous)) }))
        setStorageWarning(true); setError(t('chat.history.changeFailed'))
      }
    } finally {
      historyBusyRef.current = false
      if (mountedRef.current) setHistoryBusy(false)
    }
  }

  const openPromptEditor = (prompt: SystemPrompt) => {
    setEditingPrompt({ ...prompt, groups: prompt.groups ? [...prompt.groups] : undefined })
    setPromptEditorError('')
  }

  const savePrompt = async () => {
    if (!editingPrompt || isSavingPrompt) return
    const name = editingPrompt.name.trim()
    const prompt = editingPrompt.prompt.trim()
    if (!name || !prompt) {
      setPromptEditorError(t('chat.errors.promptRequired'))
      return
    }

    setIsSavingPrompt(true)
    setPromptEditorError('')
    try {
      const updated = await window.electronAPI.prompts.update(editingPrompt.id, {
        name,
        description: editingPrompt.description.trim(),
        prompt,
        emoji: editingPrompt.emoji?.trim() || '✨',
      })
      if (!updated) throw new Error(t('chat.errors.savePrompt'))
      setPrompts(current => current.map(item => item.id === updated.id ? updated : item))
      if (updated.id === promptId) setSavedSystemPrompt(updated.prompt)
      setEditingPrompt(null)
    } catch (saveError) {
      setPromptEditorError(saveError instanceof Error ? saveError.message : t('chat.errors.savePrompt'))
    } finally {
      setIsSavingPrompt(false)
    }
  }

  const stopGeneration = () => abortControllerRef.current?.abort()
  const copyMessage = async (content: string) => {
    try { await navigator.clipboard.writeText(content); toast({ title: t('chat.copy'), description: '✓' }) } catch { setError(t('chat.errors.copy')) }
  }

  return (
    <div data-chat-ready={historyReady && !historyBusy} className="flex min-h-[calc(100dvh-var(--page-chrome-height))] flex-col gap-3 lg:h-[calc(100vh-var(--page-chrome-height))] lg:min-h-[560px]">
      <PageHeader
        icon={Bot}
        title={t('chat.title')}
        description={t('chat.description')}
        actions={<>
          <Button variant="outline" size="sm" onClick={() => { setHistoryOpen(true); void refreshHistory() }} disabled={historyBusy}>
            <History className="mr-2 h-4 w-4" />{t('chat.history.title')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void changeConversation()} disabled={!historyReady || historyBusy}>
            <Plus className="mr-2 h-4 w-4" />{t('chat.newChat')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void changeConversation(undefined, true)} disabled={!historyReady || historyBusy || (messages.length === 0 && !input && attachments.length === 0 && !isReadingFiles && !isSending)}>
            <Trash2 className="mr-2 h-4 w-4" />{t('chat.clearChat')}
          </Button>
        </>}
      />

      {!historyReady && <p role="status" className="text-sm text-muted-foreground">{historyError || t('chat.history.loading')}</p>}
      {!isLoadingModels && model && !modelAvailable && <p role="alert" className="text-sm text-destructive">{t('chat.history.modelUnavailable', { model })}</p>}
      {modelsError && <LoadError message={modelsError} onRetry={() => { void loadWorkspace() }} retrying={isLoadingModels} />}

      <div className="rounded-xl border bg-card px-4 py-3 shadow-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
          <Select value={model} onValueChange={value => { setModel(value); setModelNotice(''); setAgentState(current => ({ ...current, sessionId: '' })) }} disabled={!historyReady || historyBusy || isLoadingModels || models.length === 0 || isSending}>
            <SelectTrigger className="w-full sm:w-[220px]" aria-label={t('chat.selectModel')}><SelectValue placeholder={t('chat.selectModel')} /></SelectTrigger>
            <SelectContent>
              {model && !modelAvailable && <SelectItem value={model} disabled>{model} · {t('chat.history.unavailable')}</SelectItem>}
              {models.map(item => <SelectItem key={item.id} value={item.id}>{item.id}{item.owner ? ` · ${item.owner}` : ''}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => { clearPreverifyCache(); void loadWorkspace() }} disabled={historyBusy || isLoadingModels || isSending} title={t('chat.refreshModels')} aria-label={t('chat.refreshModels')}>
            <RefreshCw className={cn('h-4 w-4', isLoadingModels && 'animate-spin')} />
          </Button>
          <ModelCheckBadge state={preverify} onRecheck={preverify.recheck} />
          </div>
          <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <div title={agentState.selection.workspaceId ? chinese ? '工作区聊天使用模型的默认能力。' : 'Workspace chat uses the model’s default capabilities.' : t('modelFeatures.chatHint') + (!visionEnabled ? ' ' + t('chat.visionOffHint') : '')}>
            <ModelFeatureControls compact value={features} onChange={setFeatures} disabled={!historyReady || historyBusy || isSending || !!agentState.selection.workspaceId} />
          </div>
          <ChatWorkspaceAccess collapsible inline chinese={chinese} selection={agentState.selection} disabled={!historyReady || historyBusy || isSending || workspaceAgent.running} snapshot={workspaceSnapshot || undefined} onSnapshot={setWorkspaceSnapshot} onChange={(selection: ChatWorkspaceSelection) => { setAgentState({ selection, sessionId: '', access: '' }); workspaceAgent.reset(); setError('') }} />
        </div>
      </div>

      <div className={cn('grid min-h-[440px] flex-1 gap-4 lg:min-h-0', !tasksCollapsed && 'lg:grid-cols-[240px_minmax(0,1fr)]')}>
        <Card className={cn('hidden min-h-0 flex-col overflow-hidden', !tasksCollapsed && 'lg:flex')}>
          <div className="flex items-center gap-2 border-b px-4 py-3 font-semibold" title={t('chat.tasksHint')}>
            <Sparkles className="h-4 w-4 text-primary" />{t('chat.tasks')}
            <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={() => toggleTasks(true)} title={chinese ? '收起任务栏' : 'Collapse tasks'} aria-label={chinese ? '收起任务栏' : 'Collapse tasks'}><PanelLeftClose className="h-4 w-4" /></Button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            <button
              data-task="free"
              onClick={() => choosePrompt('')}
              disabled={!historyReady || historyBusy || isSending}
              title={t('chat.freeChatHint')}
              className={cn('w-full rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/60', !promptId && 'border-primary bg-primary/5')}
            >
              <div className="text-sm font-medium">💬 {t('chat.freeChat')}</div>
            </button>
            {prompts.map(prompt => (
              <div key={prompt.id} className="group relative">
                <button
                  onClick={() => choosePrompt(prompt.id)}
                  disabled={!historyReady || historyBusy || isSending}
                  title={prompt.description}
                  className={cn('w-full rounded-lg border px-3 py-2.5 pr-10 text-left transition-colors hover:bg-muted/60', promptId === prompt.id && 'border-primary bg-primary/5')}
                >
                  <div className="text-sm font-medium">{prompt.emoji || '✨'} {prompt.name}</div>
                  <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{prompt.description}</div>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 h-8 w-8 opacity-60 hover:opacity-100"
                  onClick={() => openPromptEditor(prompt)}
                  title={t('chat.editPrompt')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {tasksCollapsed && <Button variant="ghost" size="icon" className="hidden h-8 w-8 lg:inline-flex" onClick={() => toggleTasks(false)} title={chinese ? '展开任务栏' : 'Show tasks'} aria-label={chinese ? '展开任务栏' : 'Show tasks'}><PanelLeftOpen className="h-4 w-4" /></Button>}
              <Badge variant={selectedPrompt ? 'default' : 'secondary'} className="max-w-[320px] truncate">
                {selectedPrompt ? `${selectedPrompt.emoji || '✨'} ${selectedPrompt.name}` : effectiveSystemPrompt ? t('chat.history.savedPrompt') : `💬 ${t('chat.freeChat')}`}
              </Badge>
              {isTranslation && <Select value={translationTarget} onValueChange={value => { const target = value as TranslationTarget; setTranslationTarget(target); rememberTranslationTarget(target); setAgentState(current => ({ ...current, sessionId: '' })) }} disabled={!historyReady || historyBusy || isSending}>
                <SelectTrigger className="h-8 w-[180px]" aria-label={chinese ? '翻译目标语言' : 'Translation target language'}><Languages className="mr-1 h-3.5 w-3.5 shrink-0" /><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRANSLATION_TARGETS.map(target => <SelectItem key={target.id} value={target.id}>{target.id === 'auto' ? chinese ? '自动（中文 ↔ 英文）' : 'Auto (Chinese ↔ English)' : target.label}</SelectItem>)}
                </SelectContent>
              </Select>}
            </div>
            <Select value={promptId || 'none'} onValueChange={value => choosePrompt(value === 'none' ? '' : value)} disabled={!historyReady || historyBusy || isSending}>
              <SelectTrigger className={cn('w-full sm:w-[190px]', !tasksCollapsed && 'lg:hidden')} aria-label={t('chat.tasks')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('chat.freeChat')}</SelectItem>
                {prompts.map(prompt => <SelectItem key={prompt.id} value={prompt.id}>{prompt.emoji} {prompt.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {selectedPrompt && <Button className={cn(!tasksCollapsed && 'lg:hidden')} variant="outline" size="sm" disabled={isSending} onClick={() => openPromptEditor(selectedPrompt)}><Pencil className="mr-1 h-3 w-3" />{t('common.edit')}</Button>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" onScroll={event => { const el = event.currentTarget; followOutputRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}>
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                <div className="mb-4 rounded-2xl bg-primary/10 p-4"><Bot className="h-9 w-9 text-primary" /></div>
                <h3 className="text-lg font-semibold">{t('chat.emptyTitle')}</h3>
                {!isLoadingModels && !modelsError && models.length === 0 && (
                  <div className="mt-5 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                    <AlertCircle className="h-4 w-4" />{t('chat.noModels')}
                  </div>
                )}
              </div>
            ) : (
              <div className="mx-auto max-w-4xl space-y-5">
                {messages.map((message, index) => (
                  <div key={message.id} className={cn('flex gap-3', message.role === 'user' && 'justify-end')}>
                    {message.role === 'assistant' && <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10"><Bot className="h-4 w-4 text-primary" /></div>}
                    <div className={cn('group min-w-0 max-w-[85%] rounded-2xl px-4 py-3 text-sm [overflow-wrap:anywhere]', message.role === 'user' ? 'bg-primary text-primary-foreground' : 'border bg-muted/35')}>
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="mb-3 flex flex-wrap gap-2">
                          {message.attachments.map(item => item.kind === 'image' ? (
                            <img key={item.id} src={item.content} alt={item.name} className="max-h-48 max-w-full rounded-lg object-contain sm:max-w-[260px]" />
                          ) : (
                            <div key={item.id} className="flex items-center gap-2 rounded-md bg-black/10 px-2 py-1 text-xs"><FileText className="h-3.5 w-3.5" />{item.name}</div>
                          ))}
                        </div>
                      )}
                      {message.reasoning && (
                        <details className="mb-3 rounded-md border border-current/15 p-2 text-xs opacity-75">
                          <summary className="cursor-pointer">{t('chat.reasoning')}</summary>
                          <div className="mt-2 whitespace-pre-wrap">{message.reasoning}</div>
                        </details>
                      )}
                      {message.content ? <MessageMarkdown text={message.content} /> : message.status ? (message.status === 'stopped' ? <span className="text-muted-foreground">{t('chat.stopped')}</span> : null) : isSending && index === messages.length - 1 ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <span className="text-muted-foreground">{t('chat.emptyResponse')}</span>}
                      {message.status === 'error' && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-sm text-destructive">{<ErrorText error={message.error || t('chat.failedMessage')} />}</p>}
                      {!!message.tools?.length && <WorkspaceAgentStatus chinese={chinese} snapshot={{ sessionId: '', running: isSending && index === messages.length - 1, text: message.content, error: '', tools: message.tools, permissions: [] }} />}
                      {(message.content || message.status || message.reasoning) && !isSending && (
                        <div className={cn('mt-2 flex items-center gap-3 text-xs', message.role === 'assistant' ? 'text-muted-foreground' : 'text-primary-foreground/75')}>
                          {message.role === 'assistant' ? (
                            <>
                              <button className="flex items-center gap-1 hover:underline" onClick={() => void copyMessage(message.content)}>
                                <Copy className="h-3 w-3" />{t('chat.copy')}
                              </button>
                              {index === messages.length - 1 && (
                                <button className="flex items-center gap-1 hover:underline" onClick={() => void regenerateLastResponse()}>
                                  <RotateCcw className="h-3 w-3" />{t('chat.regenerate')}
                                </button>
                              )}
                              {index === messages.length - 1 && message.content && <button className="hover:underline" onClick={() => void generateAssistant([...messages, { id: createId(), role: 'user', content: t('chat.continuePrompt') }])}>{t('chat.continue')}</button>}
                            </>
                          ) : (
                            <button className="flex items-center gap-1 hover:underline" onClick={() => editAndResend(index)}>
                              <Pencil className="h-3 w-3" />{t('chat.editResend')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div
            className={cn('border-t p-4 transition-colors', isDragging && 'bg-primary/10')}
            onDragEnter={event => { event.preventDefault(); setIsDragging(true) }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false) }}
            onDrop={event => { event.preventDefault(); setIsDragging(false); void addFiles(event.dataTransfer.files) }}
          >
            {verifyingModel && <div role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{t('chat.verify.inProgress')}</div>}
            {modelNotice && <div role="status" className="mb-3 rounded-md bg-muted px-3 py-2 text-sm">{modelNotice}</div>}
            {isSending && <WorkspaceAgentStatus chinese={chinese} snapshot={workspaceAgent.snapshot} showTools={false} onReply={workspaceAgent.reply} />}
            {workspaceAgent.error && isSending && <p role="alert" className="mb-2 text-destructive"><ErrorText error={workspaceAgent.error} /></p>}
            {error && <div role="alert" className="mb-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><ErrorText error={error} /></div>}
            {storageWarning && <p role="status" className="mb-2 text-xs text-destructive">{t('chat.storageWarning')}</p>}
            {attachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map(item => (
                  <div key={item.id} className="flex max-w-[260px] items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1.5 text-xs">
                    {item.kind === 'image' ? <ImageIcon className="h-4 w-4 text-primary" /> : <FileText className="h-4 w-4 text-primary" />}
                    <div className="min-w-0"><div className="truncate font-medium">{item.name}</div><div className="text-muted-foreground">{formatBytes(item.size)}</div></div>
                    <button aria-label={t('chat.removeAttachment', { name: item.name })} onClick={() => setAttachments(current => current.filter(file => file.id !== item.id))}><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="mx-auto flex max-w-4xl items-end gap-2">
              <input ref={fileInputRef} type="file" aria-label={t('chat.attach')} multiple accept={FILE_ACCEPT} className="hidden" onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
              <Button variant="outline" size="icon" onClick={() => fileInputRef.current?.click()} disabled={!historyReady || historyBusy || isSending || isReadingFiles} title={t('chat.attach') + ' · ' + t('chat.attachmentHint')}>
                <Paperclip className="h-4 w-4" />
              </Button>
              <Textarea
                ref={inputRef}
                aria-label={t('chat.placeholder')}
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault()
                    void sendMessage()
                  }
                }}
                placeholder={isDragging ? t('chat.dropFiles') : t('chat.placeholder')}
                className="max-h-44 min-h-[44px] resize-none"
                disabled={!historyReady || historyBusy}
              />
              {isSending ? (
                <Button variant="destructive" size="icon" onClick={stopGeneration} title={t('chat.stop')}><Square className="h-4 w-4" /></Button>
              ) : (
                <Button size="icon" onClick={() => void sendMessage()} disabled={!historyReady || historyBusy || (!input.trim() && attachments.length === 0) || !canVerifyModel || isLoadingModels || isReadingFiles} title={t('chat.send')}><Send className="h-4 w-4" /></Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      <ChatHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} items={historyItems} activeId={conversation.id}
        busy={historyBusy} loading={historyLoading} error={historyError} onLoad={id => void changeConversation(id)}
        onDelete={deleteHistory} onRefresh={() => void refreshHistory()} scopeLabel={item => prompts.find(prompt => prompt.id === item.promptId)?.name || t('chat.freeChat')} />

      <Dialog open={Boolean(editingPrompt)} onOpenChange={open => { if (!open && !isSavingPrompt) { setEditingPrompt(null); setPromptEditorError('') } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('chat.editPrompt')}</DialogTitle>
            <DialogDescription>{t('chat.editPromptHint')}</DialogDescription>
          </DialogHeader>
          {editingPrompt && (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-3">
                <div className="space-y-2">
                  <Label htmlFor="prompt-emoji">{t('chat.promptEmoji')}</Label>
                  <Input
                    id="prompt-emoji"
                    value={editingPrompt.emoji || ''}
                    onChange={event => setEditingPrompt(current => current ? { ...current, emoji: event.target.value } : current)}
                    maxLength={8}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="prompt-name">{t('chat.promptName')}</Label>
                  <Input
                    id="prompt-name"
                    value={editingPrompt.name}
                    onChange={event => setEditingPrompt(current => current ? { ...current, name: event.target.value } : current)}
                    maxLength={120}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-description">{t('chat.promptDescription')}</Label>
                <Input
                  id="prompt-description"
                  value={editingPrompt.description}
                  onChange={event => setEditingPrompt(current => current ? { ...current, description: event.target.value } : current)}
                  maxLength={240}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prompt-content">{t('chat.promptContent')}</Label>
                <Textarea
                  id="prompt-content"
                  value={editingPrompt.prompt}
                  onChange={event => setEditingPrompt(current => current ? { ...current, prompt: event.target.value } : current)}
                  className="min-h-[220px] resize-y"
                />
              </div>
            </div>
          )}
          {promptEditorError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{promptEditorError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingPrompt(null); setPromptEditorError('') }} disabled={isSavingPrompt}>{t('common.cancel')}</Button>
            <Button onClick={() => void savePrompt()} disabled={isSavingPrompt || !editingPrompt?.name.trim() || !editingPrompt?.prompt.trim()}>
              {isSavingPrompt && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Chat
