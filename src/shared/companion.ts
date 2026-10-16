export type CompanionMode = 'chat' | 'agent'
export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working'
export interface WorkspaceGrant { id: string; path: string; name: string; writable: boolean }
export interface WorkspaceGroup { id: string; name: string; workspaceIds: string[] }
export interface WorkspaceGroupInput { id?: string; name: string; workspaceIds: string[] }
export interface DroppedFolder { path: string; name: string; workspaceId?: string; writable: boolean }
export interface WorkspaceImportInput {
  folders: Array<{ path: string; writable: boolean }>
  groupId?: string
  newGroupName?: string
}
export interface SpeechEndpoint { baseUrl: string; model: string; apiKey: string }
export interface CompanionSettings {
  name: string
  persona: string
  model: string
  autoSpeak: boolean
  speechEnabled: boolean
  ttsMode: 'local' | 'system' | 'api'
  localVoice: string
  localEngine: 'fast' | 'kokoro'
  systemFallback: boolean
  language: string
  systemVoice: string
  voice: string
  speechRate: number
  speechVolume: number
  speechPitch: number
  readingMode: 'summary' | 'full'
  sttMode: 'local' | 'api'
  stt: SpeechEndpoint
  tts: SpeechEndpoint
  avatar: string
  avatarVisible: boolean
  avatarMode: '2d' | '3d'
  avatarModel: string
}
export interface CompanionMessage {
  id: string; role: 'user' | 'assistant'; content: string; mode: CompanionMode; createdAt: number
  tools?: AgentTool[]; toolStatus?: 'none' | 'used'; error?: string
  model?: string; retryOf?: string
}
export interface OpenCodeRuntimeStatus {
  currentVersion: string; latestVersion: string; checkedAt: number; releaseUrl: string
  updateAvailable: boolean; checking: boolean; installing: boolean; error: string
  source: 'managed' | 'bundled' | 'missing'
}
export interface OpenCodeFreeCatalogue {
  models: Array<{ id: string; apiModel: string; name: string; contextLimit: number; outputLimit: number; toolCall: boolean }>
  updatedAt: number | null; stale: boolean; error?: string
}
export interface CompanionSnapshot {
  assetsIncluded?: boolean
  warnings?: string[]
  settings: CompanionSettings
  workspaces: WorkspaceGrant[]
  groups: WorkspaceGroup[]
  messages: CompanionMessage[]
  home: string
  avatarUrl: string
  avatarModelUrl: string
  avatarModelError?: string
  runtimeAvailable: boolean
  /** Claude Code found on this computer; DailyWorkMate runs it with the local proxy and its own config folder. */
  claudeCode?: ClaudeCodeStatus
  accessibilitySupportEnabled?: boolean
}
export interface ClaudeCodeStatus { available: boolean; path: string }
/** The coding agent that serves a workspace chat or Work tab. */
export type AgentEngine = 'opencode' | 'claude'
export function agentEngine(value: unknown): AgentEngine {
  if (value === undefined || value === 'opencode') return 'opencode'
  if (value === 'claude') return 'claude'
  throw new Error('Invalid agent engine')
}
export interface WorkspaceEntry { name: string; relativePath: string; directory: boolean }
export interface SpeechAudio { audio: Uint8Array; mime: string; notice?: string }
export interface AgentPermission { id: string; sessionID: string; permission: string; patterns: string[] }
export interface AgentTool { id: string; name: string; status: string; title: string }
export interface AgentSnapshot {
  phase?: 'thinking' | 'responding' | 'tool'
  sessionId: string
  running: boolean
  text: string
  error: string
  tools: AgentTool[]
  permissions: AgentPermission[]
}
export interface AgentInput {
  workspaceId: string; model: string; prompt: string; newSession?: boolean; sessionId?: string
  systemPrompt?: string
  groupId?: string
  accessScope?: 'group' | 'folder'
  relativePath?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  engine?: AgentEngine
}
export interface CompanionAPI {
  openTerminal: (input: TerminalInput) => Promise<TerminalSnapshot>
  pollTerminal: (id: string, cursor: number) => Promise<TerminalSnapshot>
  reconnectTerminal: (id: string, cols: number, rows: number) => Promise<TerminalSnapshot>
  writeTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  closeTerminal: (id: string) => Promise<void>
  openCodeStatus: () => Promise<OpenCodeRuntimeStatus>
  checkOpenCodeUpdate: () => Promise<OpenCodeRuntimeStatus>
  installOpenCodeUpdate: () => Promise<OpenCodeRuntimeStatus>
  openCodeModels: (forceRefresh?: boolean) => Promise<OpenCodeFreeCatalogue>
  get: () => Promise<CompanionSnapshot>
  saveSettings: (settings: CompanionSettings) => Promise<CompanionSnapshot>
  saveMessages: (messages: CompanionMessage[]) => Promise<void>
  pickAvatar: () => Promise<CompanionSnapshot>
  pickAvatarModel: () => Promise<CompanionSnapshot>
  resetAvatar: () => Promise<CompanionSnapshot>
  resetAvatarModel: () => Promise<CompanionSnapshot>
  addWorkspace: () => Promise<CompanionSnapshot>
  inspectFolders: (paths: string[]) => Promise<DroppedFolder[]>
  importWorkspaces: (input: WorkspaceImportInput) => Promise<CompanionSnapshot>
  openWorkspace: (id: string, relativePath?: string) => Promise<void>
  openTerminalDirectory: (id: string) => Promise<void>
  updateWorkspace: (id: string, writable: boolean | null) => Promise<CompanionSnapshot>
  saveWorkspaceGroup: (group: WorkspaceGroupInput) => Promise<CompanionSnapshot>
  deleteWorkspaceGroup: (id: string) => Promise<CompanionSnapshot>
  listFiles: (id: string, relativePath: string) => Promise<WorkspaceEntry[]>
  readFile: (id: string, relativePath: string) => Promise<string>
  transcribe: (audio: Uint8Array, mime: string) => Promise<string>
  synthesize: (text: string, settings?: CompanionSettings) => Promise<SpeechAudio>
  cancelSpeech: () => Promise<void>
  localSpeechStatus: () => Promise<import('./localSpeech').LocalSpeechStatus>
  warmupSpeech: () => Promise<import('./localSpeech').LocalSpeechStatus>
  startAgent: (input: AgentInput) => Promise<AgentSnapshot>
  pollAgent: () => Promise<AgentSnapshot>
  stopAgent: () => Promise<void>
  replyPermission: (id: string, allow: boolean) => Promise<void>
}

export interface TerminalInput extends Omit<AgentInput, 'prompt'> { cols: number; rows: number; terminalId?: string }
export interface TerminalSnapshot {
  id: string; sessionId: string; running: boolean; data: string; cursor: number; error: string; reset: boolean
  /** Startup is still pending; a disconnected view must wait rather than replace this process. */
  starting?: boolean
  /** Ended because its folder permissions changed; reopen it to apply the current ones. */
  accessChanged?: boolean
  /** The original OpenCode server is still alive; only its terminal display needs reattaching. */
  canReconnect?: boolean
}

const LEGACY_COMPANION_PERSONA = '你是小伴，一位友好、可靠的虚拟伙伴。用用户使用的语言自然地回答，根据问题需要提供完整的解释，不必为了朗读缩短文字。普通聊天不能访问文件或执行操作；如需操作文件，请引导用户切换到工作模式。不要声称完成了未执行的操作。'

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  name: 'DailyWorkMate',
  persona: '你是 DailyWorkMate，一位友好、可靠的虚拟伙伴。用用户使用的语言自然地回答，根据问题需要提供完整的解释，不必为了朗读缩短文字。需要访问文件时使用当前授权工作区的工具，未连接工作区时提示用户选择工作区。不要声称完成了未执行的操作。',
  model: '', autoSpeak: true, speechEnabled: true, ttsMode: 'local', localVoice: 'auto', localEngine: 'fast', systemFallback: true, language: 'zh-CN', systemVoice: '',
  voice: 'alloy', speechRate: 1, speechVolume: 1, speechPitch: 1, readingMode: 'summary', avatar: '',
  avatarVisible: true, avatarMode: '2d', avatarModel: '', sttMode: 'local',
  stt: { baseUrl: '', model: 'whisper-1', apiKey: '' },
  tts: { baseUrl: '', model: 'tts-1', apiKey: '' },
}

/** Upgrade only the former defaults; leave user-written names and instructions intact. */
export function migrateCompanionName(settings: CompanionSettings): CompanionSettings {
  const name = ['小伴', 'Companion'].includes(settings.name) ? 'DailyWorkMate' : settings.name
  const previousPersona = DEFAULT_COMPANION_SETTINGS.persona.replace(' DailyWorkMate', '小伴')
  const persona = [previousPersona, LEGACY_COMPANION_PERSONA].includes(settings.persona)
    ? DEFAULT_COMPANION_SETTINGS.persona.replace('DailyWorkMate', name) : settings.persona
  return { ...settings, name, persona }
}

export function renameCompanion(settings: CompanionSettings, name: string): CompanionSettings {
  const defaultPersona = DEFAULT_COMPANION_SETTINGS.persona.replace('DailyWorkMate', settings.name)
  const english = 'You are ' + settings.name + ', a helpful assistant. Reply in the user’s language. Ask before taking actions that change files.'
  return { ...settings, name, persona: settings.persona === defaultPersona ? DEFAULT_COMPANION_SETTINGS.persona.replace('DailyWorkMate', name)
    : settings.persona === english ? english.replace('You are ' + settings.name + ',', 'You are ' + name + ',') : settings.persona }
}

export function boundedText(value: unknown, name: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || value.includes('\0')) {
    throw new Error('Invalid ' + name)
  }
  return value
}

export function speechUrl(base: string, endpoint: string): string {
  const url = new URL(boundedText(base, 'speech URL', 2048, true))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Speech URL must be an HTTP(S) base URL without credentials, query or fragment')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('Remote speech services must use HTTPS')
  return url.toString().replace(/\/$/, '') + '/audio/' + endpoint
}

export function validateSettings(value: CompanionSettings): CompanionSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid companion settings')
  if (typeof value.autoSpeak !== 'boolean' || !['local', 'system', 'api'].includes(value.ttsMode)) throw new Error('Invalid speech mode')
  const systemFallback = value.systemFallback ?? true
  const speechEnabled = value.speechEnabled ?? true
  if (typeof speechEnabled !== 'boolean') throw new Error('Invalid speech switch setting')
  if (typeof systemFallback !== 'boolean') throw new Error('Invalid speech fallback setting')
  const localEngine = value.localEngine ?? (value.localVoice && value.localVoice !== 'auto' ? 'kokoro' : 'fast')
  if (!['fast', 'kokoro'].includes(localEngine)) throw new Error('Invalid local speech engine')
  const sttMode = value.sttMode ?? (typeof value.stt?.baseUrl === 'string' && value.stt.baseUrl.trim() ? 'api' : 'local')
  if (!['local', 'api'].includes(sttMode)) throw new Error('Invalid speech recognition mode')
  if (!Number.isFinite(value.speechRate) || value.speechRate < 0.5 || value.speechRate > 2) throw new Error('Speech rate must be 0.5–2')
  const speechVolume = value.speechVolume ?? 1
  const speechPitch = value.speechPitch ?? 1
  const readingMode = value.readingMode ?? 'summary'
  const avatarVisible = value.avatarVisible ?? true
  const avatarMode = value.avatarMode ?? '2d'
  if (typeof avatarVisible !== 'boolean' || !['2d', '3d'].includes(avatarMode)) throw new Error('Invalid avatar display setting')
  if (!Number.isFinite(speechVolume) || speechVolume < 0 || speechVolume > 1) throw new Error('Speech volume must be 0–1')
  if (!Number.isFinite(speechPitch) || speechPitch < 0.5 || speechPitch > 2) throw new Error('Speech pitch must be 0.5–2')
  if (!['summary', 'full'].includes(readingMode)) throw new Error('Invalid reading mode')
  const endpoint = (input: SpeechEndpoint, active: boolean): SpeechEndpoint => {
    if (!input || typeof input !== 'object') throw new Error('Invalid speech endpoint')
    const baseUrl = boundedText(input.baseUrl, 'speech URL', 2048).trim()
    if (active) { if (!baseUrl) throw new Error('Configure the speech API URL'); speechUrl(baseUrl, 'speech') }
    return { baseUrl, model: boundedText(input.model, 'speech model', 200, true), apiKey: boundedText(input.apiKey, 'speech key', 4096) }
  }
  return {
    name: boundedText(value.name, 'character name', 80, true),
    persona: value.persona === LEGACY_COMPANION_PERSONA ? DEFAULT_COMPANION_SETTINGS.persona : boundedText(value.persona, 'persona', 16000),
    model: boundedText(value.model, 'model', 300),
    autoSpeak: value.autoSpeak, speechEnabled, ttsMode: value.ttsMode === 'system' ? 'local' : value.ttsMode,
    localVoice: boundedText(value.localVoice ?? 'auto', 'local voice', 80, true), localEngine, systemFallback,
    language: boundedText(value.language, 'language', 40, true),
    systemVoice: boundedText(value.systemVoice, 'system voice', 500),
    voice: boundedText(value.voice, 'voice', 200, true), speechRate: value.speechRate, speechVolume, speechPitch, readingMode,
    avatar: boundedText(value.avatar, 'avatar', 100), avatarVisible, avatarMode,
    avatarModel: boundedText(value.avatarModel ?? '', '3D avatar', 100), sttMode, stt: endpoint(value.stt, sttMode === 'api'), tts: endpoint(value.tts, value.ttsMode === 'api'),
  }
}
