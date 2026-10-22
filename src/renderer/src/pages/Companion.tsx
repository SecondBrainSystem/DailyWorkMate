import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowUpRight, Bot, Briefcase, ChevronLeft, ChevronsDown, ChevronsUp, Eye, EyeOff, FileText, Folder, FolderCog, History, LoaderCircle, Maximize2, Mic, Minimize2, Pencil, Plus, RefreshCw, Send, Settings2, Sparkles, Square, Terminal, Upload, Volume2, VolumeX, X } from 'lucide-react'
import { ErrorText } from '@/components/ui/error-text'
import { CompanionMessageItem } from '@/components/companion/CompanionMessageItem'
import { useErrorText } from '@/lib/errors'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirmation-provider'
import { PageHeader } from '@/components/layout/PageHeader'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Avatar } from '@/components/companion/Avatar'
import { DailyTodoNote } from '@/components/companion/DailyTodoNote'
import { useDailyTodo } from '@/hooks/useDailyTodo'
import { CompanionSettings } from '@/components/companion/CompanionSettings'
import { OpenCodePanel } from '@/components/companion/OpenCodePanel'
import { CompanionHints } from '@/components/companion/CompanionHints'
import { FolderDropDialog, useFolderDrop } from '@/components/companion/FolderDropDialog'
import { WorkSessions } from '@/components/companion/WorkSessions'
import { ModelCheckBadge } from '@/components/ui/model-check-badge'
import { clearPreverifyCache, isVerifiableModel, peekPreverify, preverifyModel, useModelPreverification } from '@/lib/modelPreverify'
import { WorkspaceGroupsPanel } from '@/components/companion/WorkspaceGroupsPanel'
import { AuthorizedFolders } from '@/components/companion/AuthorizedFolders'
import { useCompanionCopy } from '@/components/companion/copy'
import { ActivityMark } from '@/components/companion/ActivityMark'
import type { ActivityState } from '@/lib/terminalActivity'
import { useVoice } from '@/components/companion/useVoice'
import { ChatHistoryDialog } from '@/components/chat/ChatHistoryDialog'
import { ChatWorkspaceAccess, WorkspaceAgentStatus } from '@/components/chat/ChatWorkspaceAccess'
import { useWorkspaceAgent } from '@/hooks/useWorkspaceAgent'
import { FOCUS_MODE_SHORTCUT, useFocusMode } from '@/hooks/useFocusMode'
import { chatWorkspaceIdentity, workspaceSelectionFromState, workspaceStateFields, type ChatWorkspaceSelection } from '@/lib/workspaceAgent'
import { ChatHistoryStorage, conversationSummary, createConversation, type ChatConversation, type ChatHistorySummary } from '@/lib/chatHistory'
import { companionScope as scopeFor } from '@/lib/companionGroups'
import { mergeCompanionSnapshot } from '@/lib/companionSnapshot'
import { createToolRecoveryCandidate, createToolRecoveryRetryInput, type ToolRecoveryCandidate } from '@/lib/companionToolRecovery'
import { describeWorkScope, useWorkSessions, type WorkScope } from '@/lib/workSessions'
import { DEFAULT_COMPANION_SETTINGS } from '../../../shared/companion'
import type { AgentEngine, AvatarState, CompanionMessage, CompanionMode, CompanionSettings as Settings, CompanionSnapshot, WorkspaceEntry, OpenCodeFreeCatalogue } from '@shared/companion'
import { fetchWithHeaderTimeout, readChatCompletionStream } from '@/lib/chatClient'
import { internalInferenceFetch } from '@/lib/internalInferenceClient'
import { isKiloFreeModel } from '@shared/freeModels'
import '@/components/companion/companion.css'

// xterm loads the first time the Terminal view opens.
const TerminalPanel = lazy(() => import('@/components/companion/TerminalPanel').then(module => ({ default: module.TerminalPanel })))
const companionHistory = new ChatHistoryStorage('dailyworkmate.companion.history.v1')
/** "Chat only" answers straight from the model; OpenCode v2 and Claude Code are workspace agents. */
type ChatEngine = AgentEngine | 'chat'
const HANDOFF_TOOL = 'use_workspace_agent'
const VIEW_KEY = 'dailyworkmate.companion.view'
const readView = () => { try { return localStorage.getItem(VIEW_KEY) || 'chat' } catch { return 'chat' } }
const STAGE_OPTIONS_KEY = 'dailyworkmate.companion.stageOptions'
// Work and Terminal can fold everything above the sessions into the tab row, leaving the space to the terminal.
const COMPACT_HEADER_KEY = 'dailyworkmate.companion.compactHeader'
const readCompactHeader = () => { try { return localStorage.getItem(COMPACT_HEADER_KEY) === 'true' } catch { return false } }
const readStageOptions = () => { try { return localStorage.getItem(STAGE_OPTIONS_KEY) === 'true' } catch { return false } }
const saveView = (view: 'chat' | 'agent' | 'terminal') => { try { localStorage.setItem(VIEW_KEY, view) } catch { /* per-viewer convenience only */ } }

export function Companion({ visible = true }: { visible?: boolean }) {
  const confirm = useConfirm(visible)
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const copy = useCompanionCopy()
  // Shown on the Work and Terminal tabs so a finished agent turn or command is visible from any view.
  const [terminalActivity, setTerminalActivity] = useState<ActivityState>('idle')
  const [workActivity, setWorkActivity] = useState<ActivityState>('idle')
  const activityDescription = (state: ActivityState) => state === 'idle' ? {} : { title: t('terminal.activity.' + state), 'aria-description': t('terminal.activity.' + state) }
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null)
  const [settings, setSettings] = useState<Settings>(structuredClone(DEFAULT_COMPANION_SETTINGS))
  const [messages, setMessages] = useState<CompanionMessage[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelNames, setModelNames] = useState<Record<string, string>>({})
  const [kiloModelsError, setKiloModelsError] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [toolRecovery, setToolRecovery] = useState<ToolRecoveryCandidate | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryModel, setRecoveryModel] = useState('')
  const [freeCatalogue, setFreeCatalogue] = useState<OpenCodeFreeCatalogue>({ models: [], updatedAt: null, stale: true })
  const [freeModelsLoading, setFreeModelsLoading] = useState(true)
  const [openCodeOpen, setOpenCodeOpen] = useState(false)
  // The assistant always keeps its chat conversation; Work and Terminal are views beside it.
  const [mode, setMode] = useState<CompanionMode>(() => readView() === 'agent' ? 'agent' : 'chat')
  const [terminalOpen, setTerminalOpen] = useState(false)
  // Avatar and reading options stay folded under the avatar until opened.
  const [stageOptionsOpen, setStageOptionsOpen] = useState(readStageOptions)
  const saveStageOptions = (open: boolean) => { setStageOptionsOpen(open); try { localStorage.setItem(STAGE_OPTIONS_KEY, String(open)) } catch { /* per-viewer convenience only */ } }
  const [compactHeader, setCompactHeader] = useState(readCompactHeader)
  // The Terminal panel renders its options button into this slot of the control row (see TerminalPanel).
  const [terminalToolsSlot, setTerminalToolsSlot] = useState<HTMLDivElement | null>(null)
  const toggleCompactHeader = () => setCompactHeader(value => { try { localStorage.setItem(COMPACT_HEADER_KEY, String(!value)) } catch { /* per-viewer convenience only */ } return !value })
  // The Terminal panel (and its host process) loads the first time it is opened, then stays mounted.
  const [terminalMounted, setTerminalMounted] = useState(false)
  useEffect(() => { if (terminalOpen) setTerminalMounted(true) }, [terminalOpen])
  const [groupsOpen, setGroupsOpen] = useState(false)
  // Folder grants live in one dialog; each Work session picks its folder when it opens.
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [dropped, setDropped] = useState<{ paths: string[]; target: 'workspace' | 'terminal' } | null>(null)
  const [createdTerminalId, setCreatedTerminalId] = useState('')
  const [notice, setNotice] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [modelVerifying, setModelVerifying] = useState(false)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [continuous, setContinuous] = useState(false)
  const [continuousPaused, setContinuousPaused] = useState(false)
  const [dismissedAvatarError, setDismissedAvatarError] = useState('')
  const [files, setFiles] = useState<WorkspaceEntry[]>([])
  const [folderPath, setFolderPath] = useState('')
  const [browserId, setBrowserId] = useState('')
  const [fileBusy, setFileBusy] = useState(false)
  // Size is measured once when attached, not on every render.
  const [attachment, setAttachment] = useState<{ name: string; content: string; size: number } | null>(null)
  const [savingControl, setSavingControl] = useState(false)
  const [conversation, setConversation] = useState<ChatConversation | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<ChatHistorySummary[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const switching = useRef(false)
  const initVersion = useRef(0)
  // Latest chat state for async work and saving; the history record is built only when it is saved.
  const live = useRef({ conversation, selectedModel, messages, input, attachment })
  live.current = { conversation, selectedModel, messages, input, attachment }
  const followOutput = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const recoveryRef = useRef<ToolRecoveryCandidate | null>(null)
  const mounted = useRef(true)
  const modelLoadVersion = useRef(0)
  const freeModelLoadVersion = useRef(0)
  const historyReady = useRef(false)
  const rateTimer = useRef<ReturnType<typeof setTimeout>>()
  const liveSettings = useRef(settings)
  liveSettings.current = settings
  const canSpeak = useRef(false)
  const messageList = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})
  const api = window.electronAPI?.companion
  const workspaceAgent = useWorkspaceAgent()
  const chatWorkspace = conversation ? workspaceSelectionFromState(conversation) : { workspaceId: '', groupId: '', accessScope: 'group' as const, relativePath: '' }
  const workspaceEnabled = Boolean(chatWorkspace.workspaceId)
  const chatEngine: ChatEngine = conversation?.agentEngine || 'opencode'
  const engineLabel = (engine: ChatEngine) => engine === 'chat' ? t('companion.page.chatOnly') : engine === 'claude' ? 'Claude Code' : 'OpenCode v2'
  const showError = useCallback((message: string) => { if (mounted.current) { if (message === copy.noSpeech) { setNotice(copy.noSpeech); return }; setError(errorText(message)); setContinuousPaused(true) } }, [errorText, copy.noSpeech])
  const voice = useVoice(settings, copy, text => { if (continuous) void sendRef.current(text); else setInput(current => [current, text].filter(Boolean).join(' ')) }, showError)
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const work = useWorkSessions(settings.model, () => companionHistory.conversations(), !!snapshot)
  const savedConversation = (): ChatConversation | null => {
    const { conversation, selectedModel, messages, input, attachment } = live.current
    return conversation ? createConversation({ ...conversation, model: selectedModel, messages, draft: input,
      draftAttachments: attachment ? [{ id: 'file', name: attachment.name, content: attachment.content, kind: 'text', mimeType: 'text/plain', size: attachment.size }] : [],
    }) : null
  }

  const clearToolRecovery = () => {
    recoveryRef.current = null
    setToolRecovery(null); setRecoveryOpen(false); setRecoveryModel('')
  }

  useEffect(() => {
    if (!toolRecovery || !snapshot) return
    let unchanged = false
    try {
      unchanged = conversation?.conversationId === toolRecovery.conversationId
        && chatWorkspaceIdentity(snapshot, chatWorkspace, toolRecovery.sourceModel, settings.persona, toolRecovery.engine) === toolRecovery.workspaceAccess
    } catch { /* Revoked or changed access invalidates the one-shot retry. */ }
    if (!unchanged) {
      recoveryRef.current = null
      setToolRecovery(null); setRecoveryOpen(false); setRecoveryModel('')
      setNotice(t('companion.page.contextChanged'))
    }
  }, [toolRecovery, snapshot, conversation?.conversationId, chatWorkspace.workspaceId, chatWorkspace.groupId, chatWorkspace.accessScope, chatWorkspace.relativePath, settings.persona, t])

  const applyConversation = (entry: ChatConversation, defaultModel = settings.model) => {
    clearToolRecovery()
    workspaceAgent.reset()
    const file = entry.draftAttachments?.[0]
    const next = { conversation: entry, selectedModel: entry.model || defaultModel, input: entry.draft || '',
      messages: entry.messages.map(message => ({ ...message, mode: 'chat' as const, createdAt: entry.createdAt })),
      attachment: file ? { name: file.name, content: file.content, size: file.size } : null }
    live.current = next
    followOutput.current = true
    setConversation(next.conversation)
    setSelectedModel(next.selectedModel)
    setMessages(next.messages)
    setInput(next.input)
    setAttachment(next.attachment)
    setError('')
  }
  /** Load a saved chat (or a new one with `fresh`), saving the current one first. */
  const switchConversation = async (targetId?: string, fresh = false, removeId?: string) => {
    if (!historyReady.current || busyRef.current || switching.current) return
    switching.current = true; setHistoryBusy(true)
    setNotice('')
    setContinuous(false); voice.stop()
    try {
      const next = (targetId ? await companionHistory.get(targetId) : fresh ? undefined : await companionHistory.activeForScope('chat')) || createConversation({
        messages: [], model: selectedModel, promptId: 'chat', vision: 'auto', thinking: 'auto',
      })
      if (next.promptId !== 'chat') throw new Error(t('companion.page.oldWorkRecord'))
      await companionHistory.transition(next, removeId ? undefined : savedConversation() || undefined, removeId)
      if (!mounted.current) return
      applyConversation(next)
      setHistoryItems(await companionHistory.list()); setHistoryOpen(false)
    } catch (error) { showError(String(error)) }
    finally { switching.current = false; if (mounted.current) setHistoryBusy(false) }
  }

  const saveSettings = async (next: Settings) => {
    const result = await api.saveSettings(next)
    applySnapshot(result)
  }
  const applySnapshot = (result: CompanionSnapshot) => {
    if (!mounted.current) return
    setSnapshot(current => mergeCompanionSnapshot(current, result)); setSettings(result.settings)
  }
  const control = async (work: () => Promise<CompanionSnapshot>) => {
    if (savingControl) return
    setSavingControl(true); setError('')
    try {
      const result = await work()
      if (!mounted.current) return
      applySnapshot(result)
    } catch (error) { showError(error instanceof Error ? error.message : String(error)) }
    finally { if (mounted.current) setSavingControl(false) }
  }
  const toggleSpeech = async () => {
    if (savingControl || !snapshot) return
    const previous = settings
    const next = { ...settings, speechEnabled: settings.speechEnabled === false }
    setSettings(next); setSavingControl(true); setError('')
    try {
      const result = await api.saveSettings(next)
      applySnapshot(result)
    } catch (error) {
      if (mounted.current) setSettings(previous)
      showError(error instanceof Error ? error.message : String(error))
    } finally { if (mounted.current) setSavingControl(false) }
  }
  const updateGroup = async (work: () => Promise<CompanionSnapshot>) => {
    setSavingControl(true)
    try { applySnapshot(await work()) }
    finally { if (mounted.current) setSavingControl(false) }
  }
  const openHistory = async () => {
    try {
      const current = savedConversation()
      if (current) await companionHistory.save(current)
      setHistoryItems(await companionHistory.list()); setHistoryOpen(true)
      setContinuous(false); voice.stop()
    } catch (error) { showError(String(error)) }
  }

  const loadModels = async (signal?: AbortSignal, refresh = false) => {
    const version = ++modelLoadVersion.current
    signal?.throwIfAborted()
    const response = await internalInferenceFetch('/v1/models', { signal, headers: refresh ? { 'X-Refresh-Free-Models': 'true' } : {} })
    if (!response.ok) throw new Error(t('companion.page.catalogHttp', { status: response.status }))
    const { data, kilo } = await response.json() as { data?: Array<{ id: string; name?: string }>; kilo?: { stale: boolean; error?: string } }
    signal?.throwIfAborted()
    if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== 'string' || !item.id.trim())) {
      throw new Error(t('companion.page.invalidCatalog'))
    }
    const ids = [...new Set(data.map(item => item.id))]
    if (mounted.current && version === modelLoadVersion.current) {
      setModels(ids)
      setModelNames(Object.fromEntries(data.map(item => [item.id, item.name || item.id])))
      setKiloModelsError(kilo?.stale ? kilo.error || t('freeModels.kiloUnavailable') : '')
    }
    return ids
  }
  const loadFreeModels = async (refresh = false) => {
    const version = ++freeModelLoadVersion.current
    setFreeModelsLoading(true)
    try {
      const catalogue = await api.openCodeModels(refresh)
      if (mounted.current && version === freeModelLoadVersion.current) setFreeCatalogue(catalogue)
      return catalogue
    } catch (failure) {
      if (mounted.current && version === freeModelLoadVersion.current) setFreeCatalogue(current => ({ ...current, stale: true, error: failure instanceof Error ? failure.message : String(failure) }))
      throw failure
    } finally { if (mounted.current && version === freeModelLoadVersion.current) setFreeModelsLoading(false) }
  }
  /**
   * Loads the companion snapshot and the chat history. A failure still leaves an empty, usable chat
   * (a missing conversation locks sending, history and the tabs) plus a Retry action.
   */
  const initialize = async () => {
    const version = ++initVersion.current
    const current = () => mounted.current && version === initVersion.current
    const retry = historyReady.current
    // A retry must not race sends, saves or conversation switches.
    if (retry) { if (busyRef.current || switching.current) return; switching.current = true; setHistoryBusy(true) }
    setHistoryError('')
    let model = liveSettings.current.model
    try {
      const result = await api.get()
      if (!current()) return
      setSnapshot(previous => mergeCompanionSnapshot(previous, result)); setSettings({ ...DEFAULT_COMPANION_SETTINGS, ...result.settings })
      model = result.settings.model
      const legacy = (mode: CompanionMode) => ({ messages: result.messages.filter(message => message.mode === mode), model: result.settings.model, promptId: scopeFor(mode, result.workspaces[0]?.id || ''), vision: 'auto' as const, thinking: 'auto' as const })
      let entry = await companionHistory.initialize(legacy('chat'), [legacy('agent')])
      // History lives in IndexedDB now; drop the migrated legacy copy so companion.json stops carrying it.
      if (result.messages.length) await api.saveMessages([])
      if (entry.promptId !== 'chat') {
        // Older versions kept Work as a conversation; Work sessions now carry it (see useWorkSessions).
        entry = await companionHistory.activeForScope('chat') || createConversation({ messages: [], model: result.settings.model, promptId: 'chat', vision: 'auto', thinking: 'auto' })
        await companionHistory.transition(entry)
      }
      // After a failed start the user may already have chatted; keep that chat and make it the active one.
      const kept = retry ? savedConversation() : null
      if (kept && conversationSummary(kept)) await companionHistory.transition(kept)
      const items = await companionHistory.list()
      if (!current()) return
      if (!kept || !conversationSummary(kept)) applyConversation(entry, result.settings.model)
      setHistoryItems(items)
      historyReady.current = true
    } catch (error) {
      console.error('[Companion] Load assistant and chat history:', error)
      if (!current()) return
      if (!live.current.conversation) applyConversation(createConversation({ messages: [], model, promptId: 'chat', vision: 'auto', thinking: 'auto' }), model)
      historyReady.current = true
      setHistoryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (retry && current()) { switching.current = false; setHistoryBusy(false) }
    }
  }
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    if (!api) { showError('The desktop companion bridge is unavailable. Restart the desktop application.'); return }
    void initialize()
    void loadModels().catch(error => { if (!cancelled) showError(String(error)) })
    // The model-list status below reports failures without hiding configured models.
    void loadFreeModels().catch(() => {})
    // Only a Terminal view left open needs the terminal host at startup.
    if (window.electronAPI.terminal && readView() === 'terminal') void window.electronAPI.terminal.get().then(result => {
      if (!cancelled && result.preferences.restoreOnStartup && readView() === 'terminal') setTerminalOpen(true)
    }).catch(error => { if (!cancelled) showError(String(error)) })
    return () => {
      cancelled = true; mounted.current = false
      clearTimeout(rateTimer.current)
      controller.current?.abort()
      const current = savedConversation()
      if (historyReady.current && current && !switching.current) void companionHistory.save(current).catch(error => console.error('[Companion] Save on navigation:', error))
    }
  }, [])
  useEffect(() => {
    if (!historyReady.current || busy || historyBusy) return
    const timer = setTimeout(() => {
      const current = switching.current ? null : savedConversation()
      if (current) void companionHistory.save(current).catch(error => showError(String(error)))
    }, 350)
    return () => clearTimeout(timer)
  }, [messages, input, attachment, conversation, selectedModel, busy, historyBusy, showError])
  // Follow streamed output only while the reader is at the bottom, and scroll just the message list.
  useEffect(() => {
    const list = messageList.current
    if (list && followOutput.current) list.scrollTop = list.scrollHeight
  }, [messages])
  useEffect(() => { if (mode === 'agent') page.current?.scrollIntoView({ block: 'start' }) }, [mode])
  const chatView = visible && mode === 'chat' && !terminalOpen
  const dailyTodo = useDailyTodo({ api, workspaces: snapshot?.workspaces || [], messages, workspaceId: chatWorkspace.workspaceId, active: chatView && !!snapshot, busy })
  canSpeak.current = chatView
  useEffect(() => {
    if (!visible) {
      setContinuous(false); voice.stop()
      // This page stays mounted for its terminals. Portalled dialogs must not
      // retain an input lock over the page the user navigates to.
      setSettingsOpen(false); setGroupsOpen(false); setFoldersOpen(false)
      setOpenCodeOpen(false); setHistoryOpen(false); setBrowserId(''); setDropped(null)
    }
  }, [visible])
  useEffect(() => {
    if (!visible) {
      recoveryRef.current = null
      setToolRecovery(null); setRecoveryOpen(false); setRecoveryModel('')
      controller.current?.abort()
      if (workspaceAgent.running) void workspaceAgent.cancel().catch(error => showError(String(error)))
    }
  }, [visible, workspaceAgent.running, workspaceAgent.cancel, showError])
  const workView = mode === 'agent' && !terminalOpen
  const focusMode = useFocusMode(visible && (workView || terminalOpen), page)
  useEffect(() => {
    if (!continuous || continuousPaused || !chatView || busy || voice.recording || voice.transcribing || voice.speaking || settingsOpen || groupsOpen || foldersOpen || openCodeOpen || historyOpen || !snapshot) return
    const timer = setTimeout(() => { void voice.startRecording() }, 650)
    return () => clearTimeout(timer)
  }, [continuous, continuousPaused, chatView, busy, voice.recording, voice.transcribing, voice.speaking, settingsOpen, groupsOpen, foldersOpen, openCodeOpen, historyOpen, snapshot])

  // Stable so memoized messages are not re-rendered by every page update.
  const speakMessage = useCallback((message: CompanionMessage, reading: 'summary' | 'full') => {
    setContinuous(false)
    void voiceRef.current.speak(message.content, reading, message.model || live.current.selectedModel)
  }, [])
  const stop = () => { setContinuousPaused(true); voice.stop(); controller.current?.abort(); if (continuous) setNotice(t('companion.page.continuousPaused')) }

  const send = async (spoken?: string, recovery?: { candidate: ToolRecoveryCandidate; model: string }) => {
    const text = recovery ? recovery.candidate.prompt : (spoken ?? input).trim()
    if (!text) return
    if (mode !== 'chat' || busyRef.current || switching.current || savingControl || settingsOpen || groupsOpen || foldersOpen || openCodeOpen || historyOpen || !historyReady.current || !snapshot) {
      if (spoken !== undefined && !recovery) setInput(current => [current, text].filter(Boolean).join(' '))
      setNotice(t('companion.page.sendUnavailable'))
      return
    }
    if (recovery && (recoveryRef.current !== recovery.candidate || !recovery.model || recovery.model === recovery.candidate.sourceModel)) return
    const attached = !recovery && spoken === undefined && attachment ? '\n\n<attached-file name=' + JSON.stringify(attachment.name) + '>\n' + attachment.content + '\n</attached-file>' : ''
    const prompt = text + attached
    if (prompt.length > 2_000_000) { showError(t('companion.page.messageTooLong')); return }
    voice.stop()
    if (settings.speechEnabled !== false && settings.autoSpeak && settings.ttsMode !== 'api') {
      void api.warmupSpeech().catch(error => console.warn('[Voice] Background preparation:', error))
    }
    busyRef.current = true; setBusy(true); setError('')
    clearToolRecovery()
    if (recovery) { setContinuous(false); setNotice('') }
    const request = new AbortController()
    controller.current = request
    const previous = messages
    const conversationId = conversation?.conversationId || ''
    const requestActive = () => mounted.current && !request.signal.aborted && controller.current === request && live.current.conversation?.conversationId === conversationId
    const requestModel = recovery?.model || selectedModel
    const chosenEngine: ChatEngine = recovery?.candidate.engine ?? chatEngine
    // Chat-only turns that need workspace tools run in OpenCode v2.
    const engine: AgentEngine = chosenEngine === 'claude' ? 'claude' : 'opencode'
    const workspace = recovery?.candidate.workspace || chatWorkspace
    const systemPrompt = recovery?.candidate.systemPrompt ?? settings.persona
    const history = recovery?.candidate.history || previous.filter(message => message.mode === 'chat' && message.content.trim()).slice(-80).map(({ role, content }) => ({ role, content }))
    const user: CompanionMessage = { id: crypto.randomUUID(), role: 'user', content: prompt, mode: 'chat', createdAt: Date.now() }
    const answer: CompanionMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', mode: 'chat', createdAt: Date.now(), ...(requestModel ? { model: requestModel } : {}), ...(recovery ? { retryOf: recovery.candidate.answerId } : {}) }
    let output = ''
    let answerAdded = false
    let observedToolCount = 0
    let observedPermissionCount = 0
    const validateRecovery = (current: CompanionSnapshot) => {
      if (!recovery) return undefined
      // Settings can change in another window. Compare both the renderer and fresh store.
      if (current.settings.persona !== systemPrompt || liveSettings.current.persona !== systemPrompt || previous.at(-1)?.id !== recovery.candidate.answerId) {
        throw new Error(t('companion.page.personaChanged'))
      }
      return createToolRecoveryRetryInput(recovery.candidate, { model: recovery.model, conversationId,
        workspace: chatWorkspace, systemPrompt: liveSettings.current.persona, snapshot: current })
    }
    // Streamed text is applied at most once per frame; flushText() applies the rest synchronously.
    let pendingText: string | undefined
    let textFrame = 0
    const flushText = () => {
      cancelAnimationFrame(textFrame); textFrame = 0
      if (pendingText === undefined) return
      const content = pendingText
      pendingText = undefined
      if (requestActive()) setMessages(current => current.map(message => message.id === answer.id ? { ...message, content } : message))
    }
    const update = (content: string) => {
      output = content
      pendingText = content
      if (!textFrame) textFrame = requestAnimationFrame(flushText)
    }
    try {
      if (recovery) {
        const current = await api.get({ assets: false })
        if (!requestActive()) return
        try { validateRecovery(current) }
        catch { applySnapshot(current); setNotice(t('companion.page.contextChanged')); return }
        setSelectedModel(recovery.model)
      }
      if (!requestActive()) return
      followOutput.current = true
      setMessages(current => [...current, ...(!recovery ? [user] : []), answer])
      answerAdded = true
      if (!recovery && spoken === undefined) { setInput(''); setAttachment(null) }
      const freeModel = requestModel.startsWith('opencode-free/')
      if (engine === 'claude' && freeModel) throw new Error(copy.claudeModelsOnly)
      const ids = freeModel ? [] : await loadModels(request.signal)
      if (!requestActive()) return
      const model = requestModel || ids[0]
      // Preserve the user's model; checking its route never substitutes another model.
      if (!model) throw new Error(copy.noModels)
      const config = await window.electronAPI.config.get()
      if (!requestActive()) return
      if (!freeModel) {
        if (!peekPreverify(model)?.ok) setModelVerifying(true)
        const response = await internalInferenceFetch('/v1/models/verify', {
          method: 'POST', signal: AbortSignal.any([request.signal, AbortSignal.timeout((config.requestTimeout || 120000) * 2 + 10000)]), body: JSON.stringify({ model, recover: false }),
        })
        const verification = await response.json() as { model?: string; verified?: boolean; skipped?: boolean; recovered?: boolean; error?: { message?: string } }
        if (!requestActive()) return
        if (!response.ok || (!verification.verified && !verification.skipped) || verification.model !== model || verification.recovered === true) throw new Error(verification.error?.message || t('companion.page.modelUnavailable'))
        setModelVerifying(false)
        if (!recovery) modelCheck.report(true, undefined, verification.skipped)
      }
      if (model !== selectedModel) {
        setSelectedModel(model)
        // The conversation persists the explicit retry model. Do not overwrite settings
        // from another window with the snapshot captured before route verification.
        if (!recovery) await saveSettings({ ...liveSettings.current, model })
      }
      if (!requestActive()) return
      setMessages(current => current.map(message => message.id === answer.id ? { ...message, model } : message))
      if (chosenEngine === 'chat' && !freeModel && !recovery) {
        const handedOff = await chatDirectly({ model, prompt, systemPrompt, history, workspace, config, signal: request.signal, onText: update })
        if (!requestActive()) return
        if (!handedOff) {
          if (canSpeak.current && liveSettings.current.autoSpeak && output) void voice.speak(output, liveSettings.current.readingMode, model).catch(failure => {
            if (mounted.current) showError(failure instanceof Error ? failure.message : String(failure))
          })
          return
        }
        update('')
        setNotice(t('companion.page.handedToWork'))
      }
      const currentWorkspace = await api.get({ assets: false })
      if (!requestActive()) return
      applySnapshot(currentWorkspace)
      const retryInput = validateRecovery(currentWorkspace)
      if (engine === 'claude' ? !currentWorkspace.claudeCode?.available : !currentWorkspace.runtimeAvailable) throw new Error(engine === 'claude' ? copy.claudeMissing : copy.runtimeMissing)
      const access = chatWorkspaceIdentity(currentWorkspace, workspace, model, systemPrompt, engine)
      const result = await workspaceAgent.execute(retryInput || {
        ...workspace, model, prompt, systemPrompt, history, ...(engine === 'claude' ? { engine } : {}),
        sessionId: conversation?.agentWorkspaceAccess === access ? conversation.agentSessionId || '' : '',
      }, {
        signal: request.signal,
        onUpdate: value => {
          if (!requestActive()) return
          observedToolCount += value.tools.length
          observedPermissionCount += value.permissions.length
          update(value.text)
          setMessages(current => current.map(message => message.id === answer.id ? { ...message, tools: value.tools, toolStatus: value.tools.length ? 'used' : 'none' } : message))
          if (value.sessionId) setConversation(current => current?.conversationId === conversationId ? { ...current, ...workspaceStateFields(workspace), agentSessionId: value.sessionId, agentWorkspaceAccess: access } : current)
        },
      })
      if (result.error) throw new Error(result.error)
      if (!requestActive()) return
      if (!recovery) {
        const candidate = createToolRecoveryCandidate({ conversationId, userId: user.id, answerId: answer.id, sourceModel: model,
          prompt, history, workspace, systemPrompt, workspaceAccess: access, engine }, { text: result.text, error: result.error,
          aborted: request.signal.aborted, running: result.running, toolCount: observedToolCount, permissionCount: observedPermissionCount })
        recoveryRef.current = candidate
        setToolRecovery(candidate)
        if (candidate) setContinuousPaused(true)
      }
      // Generation is complete; speech owns its own cancellation and activity state.
      // Do not hold the chat busy while summarizing, synthesizing or playing audio.
      if (requestActive() && canSpeak.current && liveSettings.current.autoSpeak && output) {
        void voice.speak(output, liveSettings.current.readingMode, model).catch(failure => {
          if (mounted.current) showError(failure instanceof Error ? failure.message : String(failure))
        })
      }
    } catch (error) {
      flushText()
      if (requestActive()) {
        const message = error instanceof Error ? error.message : String(error)
        setContinuousPaused(true)
        if (answerAdded) setMessages(items => items.map(item => item.id === answer.id ? { ...item, error: message } : item))
        else showError(message)
      }
    } finally {
      flushText()
      if (mounted.current && controller.current === request) {
        if (!output) setMessages(current => current.filter(message => message.id !== answer.id || message.error || message.tools?.length))
        setBusy(false); setModelVerifying(false)
      }
      if (controller.current === request) { busyRef.current = false; controller.current = null }
    }
  }
  sendRef.current = send

  /**
   * Answer from the model without an agent. With a workspace connected, the model gets one tool that
   * hands the turn to OpenCode v2; returns true when it used it. Models that reject tools are asked again without it.
   */
  const chatDirectly = async ({ model, prompt, systemPrompt, history, workspace, config, signal, onText }: {
    model: string; prompt: string; systemPrompt: string; history: Array<{ role: 'user' | 'assistant'; content: string }>
    workspace: typeof chatWorkspace; config: Awaited<ReturnType<typeof window.electronAPI.config.get>>; signal: AbortSignal; onText: (text: string) => void
  }): Promise<boolean> => {
    const info = workspace.workspaceId && snapshot ? describeWorkScope(snapshot, workspace) : undefined
    const handoff = info ? '\n\nThe user connected the workspace "' + info.name + '" (' + info.paths.join(', ') + '). You cannot see its files yourself. When answering needs reading, searching or changing files there, or running commands, call ' + HANDOFF_TOOL + ' instead of guessing.' : ''
    const request = (tools: boolean) => fetchWithHeaderTimeout('/v1/chat/completions', {
      // The user picked this model; routing rules must not replace it.
      method: 'POST', signal, headers: { 'X-DailyWorkMate-Model-Selection': 'explicit' },
      body: JSON.stringify({ model, stream: true,
        messages: [...(systemPrompt || handoff ? [{ role: 'system', content: systemPrompt + (tools ? handoff : '') }] : []), ...history, { role: 'user', content: prompt }],
        ...(tools ? { tool_choice: 'auto', tools: [{ type: 'function', function: { name: HANDOFF_TOOL,
          description: 'Hand this request to the workspace agent, which can read, search and edit files in the connected workspace and run commands there.',
          parameters: { type: 'object', properties: { reason: { type: 'string', description: 'What needs the workspace' } }, required: ['reason'] } } }] } : {}) }),
    }, (config.requestTimeout || 120000) + 10000, internalInferenceFetch)
    const read = async (tools: boolean) => {
      let text = '', handedOff = false
      await readChatCompletionStream(await request(tools), delta => {
        if (delta.toolCalls?.includes(HANDOFF_TOOL)) handedOff = true
        if (delta.content && !handedOff) { text += delta.content; onText(text) }
      })
      return handedOff
    }
    if (!info) return read(false)
    try { return await read(true) }
    catch (error) {
      if (signal.aborted || !/HTTP 4\d\d/.test(String(error)) || !/tool/i.test(String(error))) throw error
      onText('')
      return read(false)
    }
  }

  const openFolder = async (id: string, relativePath = '') => {
    setContinuous(false); voice.stop()
    setBrowserId(id); setFileBusy(true); setError('')
    try { const entries = await api.listFiles(id, relativePath); setFiles(entries); setFolderPath(relativePath) }
    catch (error) { showError(String(error)) }
    finally { setFileBusy(false) }
  }
  const refreshModels = async () => {
    setConnecting(true); setError('')
    try {
      const results = await Promise.allSettled([loadModels(undefined, true), loadFreeModels(true)])
      const ids = results[0].status === 'fulfilled' ? results[0].value : []
      const free = results[1].status === 'fulfilled' ? results[1].value.models : []
      if (!ids.length && !free.length) {
        if (results[0].status === 'rejected') throw results[0].reason
        if (results[1].status === 'rejected') throw results[1].reason
        showError(copy.noModels)
      }
      if (!selectedModel && ids.length) setSelectedModel(ids[0])
    } catch (error) { showError(String(error)) }
    finally { if (mounted.current) setConnecting(false) }
  }
  // In Work the model picker belongs to the open session (or to the next new one).
  const shownModel = workView ? work.active?.model ?? work.model : selectedModel
  // In Terminal the picker sets the default model (used by chat and passed to new Work sessions).
  const chooseModel = async (model: string) => {
    if (!model) return
    if (workView) {
      const sessionId = work.active?.id
      if (sessionId && !await confirm(t('companion.page.changeModelConfirm'))) return
      work.setModel(model, sessionId)
    } else setSelectedModel(model)
    setError(''); setNotice('')
  }
  const modelCheck = useModelPreverification(shownModel, !!snapshot && models.length > 0)
  const state: AvatarState = voice.recording ? 'listening' : voice.speaking ? 'speaking' : busy ? 'thinking' : voice.transcribing ? 'thinking' : 'idle'
  const replyPhase = busy && workspaceAgent.running ? workspaceAgent.snapshot?.phase : undefined
  const waitingText = modelVerifying ? t('companion.page.verifyingModel')
    : replyPhase === 'thinking' ? t('companion.page.thinking')
    : replyPhase === 'tool' ? t('companion.page.runningTools')
    : replyPhase === 'responding' ? t('companion.page.generating') : copy.waiting
  const locked = busy || voice.recording || voice.transcribing || connecting || savingControl || historyBusy || !conversation
  const avatarVisible = settings.avatarVisible !== false
  const speechEnabled = settings.speechEnabled !== false
  const prepareWorkTerminal = async (model: string) => {
    if (!isVerifiableModel(model)) return
    await loadModels()
    // An explicit connection/restart must retry a failed route, not replay its two-minute cache.
    if (peekPreverify(model)?.ok === false) clearPreverifyCache(model)
    // Check only the requested model's route when connecting a work session.
    const result = await preverifyModel(model)
    if (!result.ok) throw new Error(result.error || t('companion.page.verificationFailed'))
  }
  const showView = (view: 'chat' | 'agent' | 'terminal') => {
    if (view !== 'chat') { clearToolRecovery(); controller.current?.abort(); if (workspaceAgent.running) void workspaceAgent.cancel().catch(error => showError(String(error))) }
    if (view !== 'chat') { setContinuous(false); voice.stop() }
    setError(''); setNotice('')
    setTerminalOpen(view === 'terminal')
    if (view !== 'terminal') setMode(view)
    saveView(view)
  }
  const openFolders = () => { setContinuous(false); voice.stop(); setFoldersOpen(true) }
  const chooseChatWorkspace = (selection: ChatWorkspaceSelection) => {
    if (busyRef.current || switching.current) return
    if (recoveryRef.current) { clearToolRecovery(); setNotice(t('companion.page.workspaceChanged')) }
    workspaceAgent.reset()
    setConversation(current => current ? { ...current, ...workspaceStateFields(selection), agentSessionId: '', agentWorkspaceAccess: '' } : current)
  }
  const chooseChatEngine = (engine: ChatEngine) => {
    if (busyRef.current || switching.current || engine === chatEngine) return
    if (recoveryRef.current) clearToolRecovery()
    workspaceAgent.reset(); setError('')
    // Each engine keeps its own native sessions; switching starts a new one with the text history.
    setConversation(current => current ? { ...current, agentEngine: engine === 'opencode' ? undefined : engine, agentSessionId: '', agentWorkspaceAccess: '' } : current)
  }
  /** Open a Work session in a folder chosen from Folder access. */
  const openWorkSession = (scope: WorkScope) => {
    setFoldersOpen(false); showView('agent')
    if (!work.create(scope, work.model)) showError(copy.workSessionLimit)
  }
  const activeInfo = workView && work.active ? describeWorkScope(snapshot, work.active) : undefined
  const freeModelScope = workView ? activeInfo : chatView && workspaceEnabled ? describeWorkScope(snapshot, chatWorkspace) : undefined
  const accessLabel = (access: 'edit' | 'read' | 'mixed') => access === 'edit' ? copy.accessEdit : access === 'mixed' ? copy.accessMixed : copy.accessRead
  const folderSummary = activeInfo ? activeInfo.name + ' · ' + accessLabel(activeInfo.access) : copy.folderAccess + ' · ' + (snapshot?.workspaces.length || 0)
  const sessionCounts = work.open.reduce<Record<string, number>>((counts, session) => {
    const key = session.groupId && session.accessScope === 'group' ? 'group:' + session.groupId : 'folder:' + session.workspaceId
    return { ...counts, [key]: (counts[key] || 0) + 1 }
  }, {})
  const voiceControls = <>
    <div className="flex flex-wrap justify-center gap-x-5 gap-y-3 text-xs text-[var(--text-muted)]">
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.autoSpeak} disabled={locked || !snapshot || !speechEnabled} onChange={event => { void control(() => api.saveSettings({ ...settings, autoSpeak: event.target.checked })) }} />{copy.autoSpeak}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={continuous} disabled={!snapshot || settingsOpen || groupsOpen || openCodeOpen || historyOpen} onChange={event => {
        if (event.target.checked && settings.sttMode === 'api' && !settings.stt.baseUrl) { showError(copy.noStt); return }
        setError(''); setContinuousPaused(false); setContinuous(event.target.checked)
        if (!event.target.checked) voice.stop()
      }} />{copy.continuous}</label>
    </div>
    <div className="companion-playback-controls">
      <label className="companion-field">{copy.rate} · {settings.speechRate.toFixed(1)}×<input aria-label={copy.rate} type="range" min="0.5" max="2" step="0.1" value={settings.speechRate} disabled={locked || voice.speaking} onChange={event => { const speechRate = Number(event.target.value); setSettings(current => ({ ...current, speechRate })); clearTimeout(rateTimer.current); rateTimer.current = setTimeout(() => { void control(() => api.saveSettings({ ...liveSettings.current, speechRate })) }, 300) }} /></label>
      <label className="companion-field" title={copy.readingHint}>{copy.readingMode}<select aria-label={copy.readingMode} value={settings.readingMode} disabled={locked || voice.speaking} onChange={event => { void control(() => api.saveSettings({ ...settings, readingMode: event.target.value as Settings['readingMode'] })) }}><option value="summary">{copy.summary}</option><option value="full">{copy.full}</option></select></label>
    </div>
  </>

  const drop = useFolderDrop(!!snapshot && (!chatView || foldersOpen) && !dropped && !settingsOpen && !groupsOpen && !openCodeOpen, paths => {
    setContinuous(false); voice.stop()
    setDropped({ paths, target: terminalOpen && !foldersOpen ? 'terminal' : 'workspace' })
    setFoldersOpen(false)
  }, showError)

  return <div {...drop.handlers} ref={page} className={'companion-page' + (!chatView ? ' is-work' : '') + (!chatView && compactHeader ? ' is-header-collapsed' : '') + (focusMode.active ? ' is-focus-mode' : '')} data-companion-ready={!!snapshot && !!conversation && !historyBusy}>
    {drop.dragging && <div className="folder-drop-overlay" role="status"><Folder size={30} /><span>{t('companion.page.dropOverlay')}</span></div>}
    <PageHeader icon={Sparkles} title={copy.title} description={copy.subtitle} actions={<><button type="button" role="switch" aria-checked={speechEnabled} aria-label={t('companion.page.readRepliesAloud')} className="companion-speech-switch" disabled={savingControl || !snapshot} onClick={() => { void toggleSpeech() }}>{speechEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}{speechEnabled ? t('companion.page.readAloudOn') : t('companion.page.readAloudOff')}</button>
      {chatView && <Button variant="outline" size="sm" disabled={locked || !snapshot} onClick={() => { void control(() => api.saveSettings({ ...settings, avatarVisible: !avatarVisible })) }}>{avatarVisible ? <EyeOff className="mr-2 h-3.5 w-3.5" /> : <Eye className="mr-2 h-3.5 w-3.5" />}{avatarVisible ? t('companion.page.hideAvatar') : t('companion.page.showAvatar')}</Button>}
      <Button variant="outline" size="sm" disabled={locked || !snapshot} onClick={() => { setContinuous(false); voice.stop(); setSettingsOpen(true) }}><Settings2 className="mr-2 h-3.5 w-3.5" />{copy.settings}</Button></>} />
    {snapshot?.avatarModelError && dismissedAvatarError !== snapshot.avatarModelError && <p role="alert" className="companion-error"><span>{errorText(snapshot.avatarModelError)}</span><button aria-label={copy.cancel} onClick={() => setDismissedAvatarError(snapshot.avatarModelError || '')}><X size={13} /></button></p>}
    {snapshot?.warnings?.map(warning => <p key={warning} role="status" className="companion-notice">{errorText(warning)}</p>)}
    {chatView && voice.notice && <p role="status" className="mb-3 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] px-4 py-3 text-sm text-[var(--text-secondary)]">{voice.notice}<button className="ml-3" aria-label={copy.cancel} onClick={voice.clearNotice}><X size={13} /></button></p>}
    {chatView && !avatarVisible && <div className="companion-compact-controls">{voiceControls}</div>}
    <div className={'companion-layout' + (!chatView || (!avatarVisible && !dailyTodo.visible) ? ' is-avatar-hidden' : '') + (chatView && dailyTodo.visible ? ' has-daily-todo' : '')}>
      {chatView && (avatarVisible || dailyTodo.visible) && <aside className={dailyTodo.visible ? 'companion-daily-sidebar' : undefined}>
      {avatarVisible && <section className="companion-stage">
        <div className="companion-stage-header"><span className="companion-eyebrow" aria-hidden="true"><span className="companion-online" /></span><button className="companion-icon-button" title={copy.avatar + ' · ' + copy.avatarHint} aria-label={copy.avatar} disabled={locked || !snapshot} onClick={() => { void control(() => settings.avatarMode === '3d' ? api.pickAvatarModel() : api.pickAvatar()) }}><Sparkles size={16} /></button><button className="companion-icon-button" aria-label={t('companion.page.resetAvatar')} title={t('companion.page.resetAvatar')} disabled={locked || !snapshot} onClick={async () => { if (await confirm(t('companion.page.resetAvatarConfirm'))) void control(() => settings.avatarMode === '3d' ? api.resetAvatarModel() : api.resetAvatar()) }}><RefreshCw size={16} /></button></div>
        <Avatar state={state} image={snapshot?.avatarUrl || ''} name={settings.name} level={voice.level} avatarMode={settings.avatarMode} modelUrl={snapshot?.avatarModelUrl || ''} />
        <h2 className="companion-name flex max-w-full items-center justify-center gap-2"><span className="min-w-0 break-words">{settings.name}</span><button type="button" className="companion-icon-button shrink-0" aria-label={t('companion.page.editName')} title={copy.name} disabled={locked || !snapshot} onClick={() => { setContinuous(false); voice.stop(); setSettingsOpen(true) }}><Pencil size={14} /></button></h2>
        <div className={'companion-status ' + (state !== 'idle' ? 'companion-active' : '')}><div className="companion-voice-bars"><span /><span /><span /></div>{snapshot ? copy[state] : copy.loading}</div>
        <details className="companion-stage-options" open={stageOptionsOpen} onToggle={event => saveStageOptions(event.currentTarget.open)}>
          <summary>{t('companion.page.avatarAndReading')}</summary>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2"><select aria-label={t('companion.page.avatarMode')} className="companion-select" value={settings.avatarMode} disabled={locked} onChange={event => { void control(() => api.saveSettings({ ...settings, avatarMode: event.target.value as Settings['avatarMode'] })) }}><option value="2d">2D</option><option value="3d">3D</option></select>
          <button className="companion-read-button text-xs" disabled={locked} onClick={() => { void control(() => api.pickAvatarModel()) }}><Upload size={13} />{t('companion.page.importModel')}</button>
          <button className="companion-read-button text-xs" disabled={locked} onClick={() => { void control(() => api.resetAvatarModel()) }}>{t('companion.page.builtInOctopus')}</button>
        </div>
        <div className="mt-5 w-full">{voiceControls}</div>
        </details>
      </section>}
      {dailyTodo.visible && <DailyTodoNote key={chatWorkspace.workspaceId || 'personal'} model={dailyTodo} />}
      </aside>}
      <section className="companion-chat">
        <div className="companion-chat-header"><div className="companion-tabs" role="tablist" aria-label={copy.title} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length; event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click() }}>{(['chat', 'agent'] as const).map(item => <button role="tab" aria-selected={!terminalOpen && mode === item} key={item} disabled={busy || voice.transcribing || historyBusy || !conversation} {...(item === 'agent' ? activityDescription(workActivity) : {})} onClick={() => showView(item)}>{item === 'chat' ? <Bot size={14} /> : <Briefcase size={14} />}{copy[item]}{item === 'agent' && <ActivityMark state={workActivity} announce={false} />}</button>)}<button role="tab" aria-selected={terminalOpen} disabled={busy || voice.transcribing || historyBusy || !conversation} {...activityDescription(terminalActivity)} onClick={() => showView('terminal')}><Terminal size={14} />{t('companion.page.terminal')}<ActivityMark state={terminalActivity} announce={false} /></button></div>
          <div className="companion-session-controls flex min-w-0 flex-wrap items-center gap-1"><select className="companion-select companion-model-select" aria-label={copy.model} title={workView && work.active ? t('companion.page.sessionModel') : undefined} value={shownModel} disabled={workView ? !snapshot || !work.ready : locked || !snapshot} onChange={event => chooseModel(event.target.value)}><option value="" disabled>{copy.model}</option>
            {shownModel && !models.includes(shownModel) && !freeCatalogue.models.some(item => item.id === shownModel) && <option value={shownModel}>{shownModel}</option>}
            <optgroup label={copy.proxyModels}>{models.filter(model => !isKiloFreeModel(model)).map(model => <option key={model} value={model}>{model}</option>)}</optgroup>
            <optgroup label={copy.freeModels}>{freeCatalogue.models.map(model => <option key={model.id} value={model.id}>{model.name} · Free</option>)}</optgroup>
            {!!models.some(isKiloFreeModel) && <optgroup label={t('freeModels.kilo')}>{models.filter(isKiloFreeModel).map(model => <option key={model} value={model}>{modelNames[model] || model}</option>)}</optgroup>}
          </select>
          <ModelCheckBadge state={modelCheck} onRecheck={modelCheck.recheck} className="shrink-0 whitespace-nowrap" />
          <button className="companion-icon-button" aria-label="OpenCode" title="OpenCode" onClick={() => { setContinuous(false); voice.stop(); setOpenCodeOpen(true) }}><Settings2 size={15} /></button>
            <button className="companion-icon-button" title={copy.refresh} aria-label={copy.refresh} disabled={locked || !snapshot} onClick={() => void refreshModels()}><RefreshCw size={14} className={connecting ? 'animate-spin' : ''} /></button>
            {chatView && <><button className="companion-icon-button" title={copy.history} aria-label={copy.history} disabled={locked} onClick={() => { void openHistory() }}><History size={16} /></button>
            <button className="companion-icon-button" title={copy.newChat} aria-label={copy.newChat} disabled={locked} onClick={() => { void switchConversation(undefined, true) }}><Plus size={17} /></button></>}
            <Button variant="outline" size="sm" className="companion-folder-button" aria-label={copy.folderAccess} title={activeInfo ? activeInfo.paths.join('\n') : copy.folderAccessHint} disabled={!snapshot} onClick={openFolders}><FolderCog size={15} className="mr-1.5 shrink-0" /><span className="truncate">{workView ? folderSummary : String(snapshot?.workspaces.length || 0)}</span></Button>
          </div>
          {/* Tips, terminal options and view toggles live in this row as icon buttons; they never add rows of their own. */}
          <div className="companion-header-tools">
            <CompanionHints key={terminalOpen ? 'terminal' : workView ? 'work' : 'chat'} catalogue={terminalOpen ? undefined : freeCatalogue} loading={freeModelsLoading} folderDrop={!chatView}
              onRefresh={() => { void loadFreeModels(true).catch(() => { /* loadFreeModels already exposes the failure in the catalogue status. */ }) }}
              freeModelHint={(workView || chatView) && shownModel.startsWith('opencode-free/') && ((chatView && !workspaceEnabled) || freeModelScope?.access === 'read')
                ? chatView && !workspaceEnabled
                  ? t('companion.page.freeChatHint')
                  : copy.freeReadOnly
                : undefined} />
            {terminalOpen && <div ref={setTerminalToolsSlot} className="companion-terminal-tools" />}
            {(workView || terminalOpen) && <button ref={focusMode.button} type="button" className="companion-icon-button companion-focus-toggle" aria-pressed={focusMode.active}
              aria-label={focusMode.active ? t('companion.page.focus.exitLabel') : t('companion.page.focus.enterLabel')}
              aria-keyshortcuts={FOCUS_MODE_SHORTCUT}
              title={focusMode.active ? t('companion.page.focus.exitTitle', { shortcut: FOCUS_MODE_SHORTCUT }) : t('companion.page.focus.enterTitle', { shortcut: FOCUS_MODE_SHORTCUT })}
              // Never disabled: focus returns to this button on exit, and toggle() already ignores re-entry.
              aria-busy={focusMode.pending} onClick={() => void focusMode.toggle()}>
              {focusMode.active ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
            </button>}
            {(workView || terminalOpen) && <button type="button" className="companion-icon-button companion-header-toggle" aria-expanded={!compactHeader}
              aria-label={compactHeader ? t('companion.page.header.expand') : t('companion.page.header.collapse')} title={compactHeader ? t('companion.page.header.expandTitle') : t('companion.page.header.collapseTitle')}
              onClick={toggleCompactHeader}>{compactHeader ? <ChevronsDown size={16} aria-hidden="true" /> : <ChevronsUp size={16} aria-hidden="true" />}</button>}
          </div>
        </div>
        {kiloModelsError && <p role="status" className="companion-notice">{kiloModelsError}</p>}
        {isKiloFreeModel(shownModel) && <p className="companion-notice">{t('freeModels.kiloPrivacy')}</p>}
        {focusMode.failed && !chatView && <p className="companion-error" role="alert">{t('companion.page.focusFailed')}</p>}
        {historyError && <div className="companion-error" role="alert"><AlertCircle size={15} className="mt-0.5 shrink-0" /><span className="flex-1">{copy.historyLoadFailed} <ErrorText error={historyError} /></span><Button size="sm" variant="outline" disabled={historyBusy || busy} onClick={() => { void initialize() }}>{historyBusy ? <LoaderCircle size={13} className="mr-1 animate-spin" /> : null}{copy.retry}</Button></div>}
        {workView && notice && <p className="companion-notice" role="status">{notice}</p>}
        {(workView || terminalOpen) && !browserId && !historyOpen && error && <div className="companion-error" role="alert"><AlertCircle size={15} className="mt-0.5 shrink-0" /><span className="flex-1"><ErrorText error={error} /></span><button aria-label={copy.cancel} onClick={() => setError('')}><X size={13} /></button></div>}
        {snapshot && <WorkSessions onActivity={setWorkActivity} work={work} snapshot={snapshot} copy={copy} models={[...models, ...freeCatalogue.models.map(item => item.id)]} visible={visible && workView} screenReaderMode={!!snapshot.accessibilitySupportEnabled} prepare={prepareWorkTerminal}
          loadHistory={async id => (await companionHistory.get(id))?.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim()).map(({ role, content }) => ({ role: role as 'user' | 'assistant', content }))}
          onFolders={openFolders} onAddFolder={() => { void control(() => api.addWorkspace()) }} onError={showError} />}
        {(window.electronAPI?.terminal || terminalOpen) && terminalMounted && <div className="companion-terminal-panel" hidden={!terminalOpen}><Suspense fallback={null}><TerminalPanel optionsSlot={terminalToolsSlot} onActivity={setTerminalActivity} createdTerminalId={createdTerminalId} visible={visible && terminalOpen} workspaces={snapshot?.workspaces || []} model={selectedModel} onOpenWork={() => { showView('agent'); if (snapshot?.workspaces[0]) openWorkSession({ workspaceId: snapshot.workspaces[0].id, groupId: '', accessScope: 'group', relativePath: '' }); else openFolders() }} screenReaderMode={!!snapshot?.accessibilitySupportEnabled} /></Suspense></div>}
        {chatView && <><div className="border-b px-5 py-3"><ChatWorkspaceAccess
 selection={chatWorkspace} onChange={chooseChatWorkspace} disabled={locked || voice.speaking} snapshot={snapshot || undefined} onSnapshot={applySnapshot}
          collapsible summary={engineLabel(chatEngine)} trailing={<select className="companion-select" aria-label={copy.agentEngine} title={copy.agentEngine} value={chatEngine} disabled={locked || voice.speaking} onChange={event => chooseChatEngine(event.target.value as ChatEngine)}>
            <option value="chat">{engineLabel('chat')}</option><option value="opencode">OpenCode v2</option><option value="claude" disabled={!snapshot?.claudeCode?.available && chatEngine !== 'claude'}>Claude Code{snapshot?.claudeCode?.available ? '' : t('companion.work.notInstalled')}
</option>
          </select>} /></div><div ref={messageList} className="companion-messages" aria-busy={busy} onScroll={event => { const list = event.currentTarget; followOutput.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80 }}>
          {messages.length === 0 && <div className="companion-empty"><Sparkles className="mb-2 text-[var(--companion-accent)]" size={24} /><h2>{copy.greeting}</h2><div className="mt-3 grid w-full gap-2">{[copy.suggestion1, copy.suggestion2, copy.suggestion3].map(text => <button key={text} className="companion-suggestion" onClick={() => setInput(text)}>{text}<ArrowUpRight className="ml-auto shrink-0" size={14} /></button>)}</div>
            {models.length === 0 && <Button variant="outline" size="sm" disabled={connecting || !snapshot} onClick={() => void refreshModels()}>{connecting ? <LoaderCircle size={14} className="mr-2 animate-spin" /> : null}{copy.connect}</Button>}
          </div>}
          {messages.map((message, index) => {
            const last = index === messages.length - 1
            const placeholder = message.content || message.error ? undefined
              : message.tools?.length && (!busy || !last) ? t('companion.page.noText')
              : busy && last ? waitingText : copy.waiting
            const retrySource = message.retryOf ? messages.find(item => item.id === message.retryOf)?.model || t('companion.page.previousReply') : undefined
            const footer = !busy && toolRecovery?.answerId === message.id && last ? <div data-tool-recovery className="mt-3 space-y-2 rounded-lg border border-[var(--glass-border)] p-3 text-sm">
              <p>{t('companion.page.templateRefusal')}</p>
              {!recoveryOpen ? <Button size="sm" variant="outline" disabled={locked} onClick={() => { setContinuous(false); voice.stop(); setRecoveryOpen(true) }}>{t('companion.page.changeToolModel')}</Button> : <>
                <p className="text-xs text-[var(--text-muted)]">{t('companion.page.retryHint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <select className="companion-select max-w-full" aria-label={t('companion.page.retryToolModel')} value={recoveryModel} disabled={locked} onChange={event => setRecoveryModel(event.target.value)}>
                    <option value="" disabled>{t('companion.page.chooseDifferentModel')}</option>
                    <optgroup label={copy.proxyModels}>{models.filter(model => model !== toolRecovery.sourceModel).map(model => <option key={model} value={model}>{model}</option>)}</optgroup>
                    <optgroup label={copy.freeModels}>{freeCatalogue.models.filter(model => model.id !== toolRecovery.sourceModel).map(model => <option key={model.id} value={model.id}>{model.name} · Free</option>)}</optgroup>
                  </select>
                  <Button size="sm" aria-label={t('companion.page.retryWithSelected')} disabled={locked || !recoveryModel || recoveryModel === toolRecovery.sourceModel} onClick={() => { void send(undefined, { candidate: toolRecovery, model: recoveryModel }) }}>{t('companion.page.retryWithSelected')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setRecoveryOpen(false); setRecoveryModel('') }}>{copy.cancel}</Button>
                </div>
                {recoveryModel.startsWith('opencode-free/') && freeModelScope?.access === 'read' && <p data-retry-free-limit className="text-xs text-warning">{t('companion.page.freeRetryReadOnly')}</p>}
              </>}
            </div> : undefined
            return <CompanionMessageItem key={message.id} message={message} name={settings.name} copy={copy} locale={i18n.language} retrySource={retrySource} placeholder={placeholder}
              speakDisabled={busy || voice.recording || !speechEnabled} onSpeak={speakMessage} onReply={workspaceAgent.reply} footer={footer} />
          })}
        </div>
        {notice && <div className="companion-notice" role="status"><span>{notice}</span><button aria-label={copy.cancel} onClick={() => setNotice('')}><X size={13} /></button></div>}
        {!browserId && !historyOpen && error && <div className="companion-error" role="alert"><AlertCircle size={15} className="mt-0.5 shrink-0" /><span className="flex-1"><ErrorText error={error} /></span><button aria-label={copy.cancel} onClick={() => setError('')}><X size={13} /></button></div>}
        <div className="companion-composer">
          {workspaceAgent.running && !!workspaceAgent.snapshot?.permissions.length && <WorkspaceAgentStatus snapshot={{ ...workspaceAgent.snapshot, tools: [] }} onReply={workspaceAgent.reply} />}
          {attachment && <div className="mb-2 flex items-center gap-2 text-xs text-[var(--companion-accent)]"><FileText size={12} />{attachment.name}<button aria-label={copy.removeAttachment} onClick={() => setAttachment(null)}><X size={12} /></button></div>}
          <textarea aria-label={copy.placeholder} placeholder={copy.placeholder} rows={2} value={input} disabled={historyBusy} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
          <div className="companion-composer-footer"><span className="companion-composer-note" /><div className="flex gap-2">
            <button className="companion-icon-button" aria-label={t('companion.page.attachFile')} title={t('companion.page.attachFile')} disabled={!snapshot || historyBusy} onClick={openFolders}><FileText size={17} /></button>
            <button className={'companion-icon-button ' + (voice.recording ? '!text-danger' : '')} aria-label={voice.recording ? copy.finishRecord : copy.record} title={voice.recording ? copy.finishRecord : copy.record} disabled={busy || voice.transcribing || !snapshot} onClick={() => { setError(''); setContinuousPaused(false); if (voice.recording) voice.finishRecording(); else void voice.startRecording() }}>{voice.transcribing ? <LoaderCircle size={17} className="animate-spin" /> : <Mic size={17} />}</button>
            {busy || voice.speaking || voice.transcribing ? <Button size="sm" variant="outline" onClick={() => stop()}><Square size={13} className="mr-1" />{copy.stop}</Button> : <Button size="sm" disabled={!input.trim() || voice.recording || !snapshot} onClick={() => void send()}><Send size={13} className="mr-1" />{copy.send}</Button>}
          </div></div>
        </div>
        </>}
      </section>
    </div>
    {dropped && snapshot && <FolderDropDialog paths={dropped.paths} target={dropped.target} snapshot={snapshot} onClose={() => setDropped(null)} onImported={next => { applySnapshot(next); setFoldersOpen(true) }} onTerminal={id => { setCreatedTerminalId(id); showView('terminal') }} />}
    <Dialog open={foldersOpen} onOpenChange={setFoldersOpen}><DialogContent className="companion-settings max-h-[88vh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><FolderCog size={18} />{copy.folderAccess}</DialogTitle><DialogDescription>{copy.folderAccessHint}</DialogDescription></DialogHeader>
      <AuthorizedFolders onError={showError} embedded workspaces={snapshot?.workspaces || []} groups={snapshot?.groups || []} sessionCounts={sessionCounts} disabled={savingControl || !snapshot} onAdd={() => { void control(() => api.addWorkspace()) }} onGroups={() => { setFoldersOpen(false); setContinuous(false); voice.stop(); setGroupsOpen(true) }} onBrowse={id => { setFoldersOpen(false); void openFolder(id, '') }} onAccess={async (id, writable) => { if (!await confirm(t('companion.page.changeAccessConfirm'))) return; void control(() => api.updateWorkspace(id, writable)) }} onRemove={async id => { if (!await confirm(t('companion.page.removeAccessConfirm'))) return; void control(() => api.updateWorkspace(id, null)) }} onWork={openWorkSession} />
    </DialogContent></Dialog>
    {settingsOpen && snapshot && <CompanionSettings settings={settings} home={snapshot.home} copy={copy} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
    {groupsOpen && snapshot && <WorkspaceGroupsPanel groups={snapshot.groups || []} workspaces={snapshot.workspaces} onClose={() => setGroupsOpen(false)} onSave={group => updateGroup(() => api.saveWorkspaceGroup(group))} onDelete={id => updateGroup(() => api.deleteWorkspaceGroup(id))} />}
    {openCodeOpen && <OpenCodePanel
 disabled={busy || historyBusy} onClose={() => setOpenCodeOpen(false)} onUpdated={async () => { const next = await api.get({ assets: false }); applySnapshot(next); await loadFreeModels() }} />}
    <ChatHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} contextLabel={t('companion.page.historyContext')} items={historyItems.filter(item => item.promptId === 'chat')} activeId={conversation?.conversationId || ''} busy={historyBusy} loading={false} error={historyOpen ? error : ''} onLoad={id => { void switchConversation(id) }} onRefresh={() => { void companionHistory.list().then(setHistoryItems).catch(error => showError(String(error))) }} onDelete={async id => {
      if (id === conversation?.conversationId) { await switchConversation(undefined, true, id); return }
      setHistoryBusy(true)
      await companionHistory.remove(id).then(() => companionHistory.list()).then(setHistoryItems).catch(error => showError(String(error))).finally(() => setHistoryBusy(false))
    }} />
    <Dialog open={!!browserId} onOpenChange={open => { if (!open) setBrowserId('') }}><DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto"><DialogHeader><DialogTitle>{copy.browse}</DialogTitle><DialogDescription>{copy.fileNote}</DialogDescription></DialogHeader><div className="flex flex-wrap items-center gap-2 text-sm"><Button size="sm" variant="outline" disabled={fileBusy || !folderPath} onClick={() => void openFolder(browserId, folderPath.split(/[\\/]/).slice(0, -1).join('/'))}><ChevronLeft size={16} />{copy.parent}</Button><span className="min-w-0 flex-1 break-all">{snapshot?.workspaces.find(folder => folder.id === browserId)?.name} / {folderPath}</span></div>{error && <p role="alert" className="text-sm text-danger"><ErrorText error={error} /></p>}<div className="grid gap-1">{fileBusy ? <LoaderCircle className="m-4 animate-spin" /> : files.length ? files.map(file => <button className="flex items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--glass-bg)]" key={file.relativePath} onClick={async () => {
      if (file.directory) { await openFolder(browserId, file.relativePath); return }
      setFileBusy(true)
      try {
        const content = await api.readFile(browserId, file.relativePath)
        setAttachment({ name: file.name, content, size: new TextEncoder().encode(content).length }); setBrowserId(''); showView('chat')
      } catch (error) { showError(String(error)); setBrowserId('') } finally { setFileBusy(false) }
    }}>{file.directory ? <Folder size={14} /> : <FileText size={14} />}<span className="flex-1 break-all">{file.name}</span>{!file.directory && <span className="text-[var(--text-muted)]">{copy.attach}</span>}</button>) : <p className="p-3 text-xs">{copy.noFiles}</p>}</div></DialogContent></Dialog>
  </div>
}
