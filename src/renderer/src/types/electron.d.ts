import type { 
  Provider, 
  Account, 
  ProxyStatus, 
  ProxyStatistics,
  ProviderCheckResult, 
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  LoadBalanceStrategy,
  ModelMapping,
  AppConfig,
  AccountStatus,
  ProviderType,
  ProviderVendor,
  ProviderStatus,
  ApiKey,
  SystemPrompt,
  PromptType,
  ToolCallingConfig,
  LegacyToolPromptConfig,
  EffectiveModel,
  OllamaAuthInput,
  OllamaAuthType,
  OllamaImportResult,
  OllamaModelMetadata,
  OllamaNodeSummary,
} from '../../../shared/types'

export type { 
  Provider, 
  Account, 
  ProxyStatus,
  ProxyStatistics,
  ProviderCheckResult, 
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  LoadBalanceStrategy,
  ModelMapping,
  AppConfig,
  AccountStatus,
  ProviderType,
  ProviderVendor,
  ProviderStatus,
  ApiKey,
  SystemPrompt,
  PromptType,
  ToolCallingConfig,
  LegacyToolPromptConfig,
  EffectiveModel,
  OllamaAuthInput,
  OllamaAuthType,
  OllamaImportResult,
  OllamaModelMetadata,
  OllamaNodeSummary,
}

export interface CustomProviderFormData {
  name: string
  authType: AuthType
  apiEndpoint: string
  headers: Record<string, string>
  description: string
  supportedModels: string[]
  credentialFields: CredentialField[]
}

export interface BuiltinProviderConfig extends Provider {
  credentialFields: CredentialField[]
  tokenCheckEndpoint?: string
  tokenCheckMethod?: 'GET' | 'POST'
}

interface ProxyAPI {
  start: (port?: number, host?: string) => Promise<boolean>
  stop: (port?: number, host?: string) => Promise<boolean>
  getStatus: () => Promise<ProxyStatus>
  getModels: () => Promise<Array<{ id: string }>>
  onStatusChanged: (callback: (status: ProxyStatus) => void) => () => void
}

interface StoreAPI {
  get: <T>(key: string) => Promise<T | undefined>
  set: <T>(key: string, value: T) => Promise<void>
  delete: (key: string) => Promise<void>
  clearAll: () => Promise<void>
}

interface ProvidersAPI {
  getAll: () => Promise<Provider[]>
  getBuiltin: () => Promise<BuiltinProviderConfig[]>
  add: (data: {
    id?: string
    name: string
    type?: 'builtin' | 'custom'
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    supportedModels?: string[]
    credentialFields?: CredentialField[]
  }) => Promise<Provider>
  update: (id: string, updates: Partial<Provider>) => Promise<Provider | null>
  delete: (id: string) => Promise<boolean>
  checkStatus: (providerId: string) => Promise<ProviderCheckResult>
  checkAllStatus: () => Promise<Record<string, ProviderCheckResult>>
  duplicate: (id: string) => Promise<Provider>
  export: (id: string) => Promise<string>
  import: (jsonData: string) => Promise<Provider>
  updateModels: (providerId: string) => Promise<{
    success: boolean
    modelsCount?: number
    error?: string
  }>
  getEffectiveModels: (providerId: string) => Promise<EffectiveModel[]>
  addCustomModel: (providerId: string, model: { displayName: string; actualModelId: string }) => Promise<{
    success: boolean
    models: EffectiveModel[]
    error?: string
  }>
  removeModel: (providerId: string, modelName: string) => Promise<{
    success: boolean
    models: EffectiveModel[]
    error?: string
  }>
  resetModels: (providerId: string) => Promise<{
    success: boolean
    models: EffectiveModel[]
    error?: string
  }>
}

interface OllamaAPI {
  cancelScan(providerId: string): Promise<void>
  getScanProgress(): Promise<{ providerId: string; model: string; completed: number; total: number }[]>
  list: () => Promise<OllamaNodeSummary[]>
  importText: (text: string) => Promise<OllamaImportResult>
  scan: (providerId: string) => Promise<OllamaNodeSummary>
  update: (providerId: string, updates: { enabled?: boolean; name?: string }) => Promise<OllamaNodeSummary>
  updateAuth: (providerId: string, auth: OllamaAuthInput) => Promise<OllamaNodeSummary>
  setModelEnabled: (providerId: string, model: string, enabled: boolean) => Promise<OllamaNodeSummary>
  delete: (providerId: string) => Promise<boolean>
  testVision: (providerId: string, model: string) => Promise<OllamaModelMetadata>
  testModel: (providerId: string, model: string) => Promise<OllamaModelMetadata>
  pinModel: (model: string, providerId?: string) => Promise<boolean>
}

interface AccountsAPI {
  getAll: (includeCredentials?: boolean) => Promise<Account[]>
  add: (data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<Account>
  update: (id: string, updates: Partial<Account>) => Promise<Account | null>
  delete: (id: string) => Promise<boolean>
  validate: (accountId: string) => Promise<boolean>
  validateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  getById: (id: string, includeCredentials?: boolean) => Promise<Account | null>
  getByProvider: (providerId: string) => Promise<Account[]>
  getCredits: (accountId: string) => Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
    expiresAt?: number // Credit reset timestamp (milliseconds)
  } | null>
  clearChats: (accountId: string) => Promise<{ success: boolean; error?: string }>
}

interface OAuthAPI {
  startLogin: (providerId: string, providerType: ProviderVendor) => Promise<OAuthResult>
  cancelLogin: () => Promise<void>
  loginWithToken: (providerId: string, providerType: ProviderVendor, token: string) => Promise<OAuthResult>
  validateToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) => Promise<{
    valid: boolean
    tokenType?: string
    expiresAt?: number
    accountInfo?: {
      userId?: string
      email?: string
      name?: string
    }
    error?: string
  }>
  refreshToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) => Promise<{
    type: string
    value: string
    expiresAt?: number
    refreshToken?: string
  } | null>
  getStatus: () => Promise<string>
  startInAppLogin: (providerId: string, providerType: ProviderVendor, timeout?: number) => Promise<OAuthResult>
  cancelInAppLogin: () => Promise<void>
  isInAppLoginOpen: () => Promise<boolean>
  onCallback: (callback: (result: OAuthResult) => void) => () => void
  onProgress: (callback: (event: {
    status: 'idle' | 'pending' | 'success' | 'error' | 'cancelled'
    message: string
    progress?: number
    data?: Record<string, unknown>
  }) => void) => () => void
}

interface LogFilter {
  level?: LogLevel | 'all'
  providerId?: string
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

interface LogStats {
  total: number
  info: number
  warn: number
  error: number
  debug: number
}

interface LogTrend {
  date: string
  total: number
  info: number
  warn: number
  error: number
}

interface LogsAPI {
  get: (filter?: LogFilter) => Promise<LogEntry[]>
  getStats: () => Promise<LogStats>
  getTrend: (days?: number) => Promise<LogTrend[]>
  getAccountTrend: (accountId: string, days?: number) => Promise<LogTrend[]>
  clear: () => Promise<void>
  export: (format?: 'json' | 'txt') => Promise<string>
  getById: (id: string) => Promise<LogEntry | undefined>
  onNewLog: (callback: (log: LogEntry) => void) => () => void
}

interface UpdateProgressInfo {
  percent: number
  bytesPerSecond: number
  total: number
  transferred: number
}

interface UpdateDownloadedInfo {
  version: string
  releaseDate: string
  releaseNotes?: string
}

interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  progress: UpdateProgressInfo | null
  version: string | null
  releaseDate: string | null
  releaseNotes: string | null
}

interface AppAPI {
  clearCache: () => Promise<void>
  getVersion: () => Promise<string>
  checkUpdate: () => Promise<UpdateStatus>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: UpdateDownloadedInfo) => void) => () => void
  onUpdateNotAvailable: (callback: (info: UpdateDownloadedInfo) => void) => () => void
  onUpdateProgress: (callback: (progress: UpdateProgressInfo) => void) => () => void
  onUpdateDownloaded: (callback: (info: UpdateDownloadedInfo) => void) => () => void
  onUpdateError: (callback: (error: { message?: string } | string) => void) => () => void
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  showWindow: () => Promise<void>
  hideWindow: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  addApiProvider: (input: import('@shared/apiProviders').ApiProviderInput) => Promise<import('@shared/apiProviders').ApiProviderResult>
  getStartupOptions: () => Promise<{ gpuCompositing: boolean }>
  setStartupOptions: (value: { gpuCompositing: boolean }) => Promise<{ gpuCompositing: boolean }>
  relaunch: () => Promise<void>
}

interface ConfigAPI {
  get: () => Promise<AppConfig>
  update: (updates: Partial<AppConfig>) => Promise<boolean>
  onConfigChanged: (callback: (config: AppConfig) => void) => () => void
}

interface PromptsAPI {
  getAll: () => Promise<SystemPrompt[]>
  getBuiltin: () => Promise<SystemPrompt[]>
  getCustom: () => Promise<SystemPrompt[]>
  getById: (id: string) => Promise<SystemPrompt | undefined>
  add: (prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>) => Promise<SystemPrompt>
  update: (id: string, updates: Partial<SystemPrompt>) => Promise<SystemPrompt | null>
  delete: (id: string) => Promise<boolean>
  getByType: (type: PromptType) => Promise<SystemPrompt[]>
}

interface SessionConfig {
  mode: 'single'
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

interface SessionRecord {
  id: string
  providerId: string
  accountId: string
  providerSessionId: string
  parentMessageId?: string
  sessionType: 'chat' | 'agent'
  messages: any[]
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'expired' | 'deleted'
  model?: string
}

interface SessionAPI {
  getConfig: () => Promise<SessionConfig>
  updateConfig: (config: Partial<SessionConfig>) => Promise<void>
  getAll: () => Promise<SessionRecord[]>
  getActive: () => Promise<SessionRecord[]>
  getById: (id: string) => Promise<SessionRecord | undefined>
  getByAccount: (accountId: string) => Promise<SessionRecord[]>
  getByProvider: (providerId: string) => Promise<SessionRecord[]>
  delete: (id: string) => Promise<boolean>
  clearAll: () => Promise<void>
  cleanExpired: () => Promise<number>
}

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  providerName?: string
  accountId?: string
  accountName?: string
  requestBody?: string
  userInput?: string
  /** Web search enabled */
  webSearch?: boolean
  /** Reasoning effort level */
  reasoningEffort?: import('../../../shared/modelFeatures').ModelFeatureInput['reasoning_effort']
  responseStatus: number
  responsePreview?: string
  /** Response body JSON string */
  responseBody?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

interface RequestLogFilter {
  keyword?: string
  offset?: number
  summaryOnly?: boolean
  status?: 'success' | 'error'
  providerId?: string
  limit?: number
}

interface RequestLogStats {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

interface RequestLogTrend {
  date: string
  total: number
  success: number
  error: number
  avgLatency: number
}

interface RequestLogsAPI {
  get: (filter?: RequestLogFilter) => Promise<RequestLogEntry[]>
  getById: (id: string) => Promise<RequestLogEntry | undefined>
  getStats: () => Promise<RequestLogStats>
  getTrend: (days?: number) => Promise<RequestLogTrend[]>
  clear: () => Promise<void>
  onNewLog: (callback: (log: RequestLogEntry) => void) => () => void
}

interface PersistentStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalLatency: number
  lastUpdated: number
  modelUsage: Record<string, number>
  totalTokens: number
  modelTokenUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats: Record<string, DailyStatistics>
}

interface DailyStatistics {
  date: string
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalLatency: number
  modelUsage: Record<string, number>
  totalTokens: number
  modelTokenUsage: Record<string, number>
  providerUsage: Record<string, number>
}

interface StatisticsAPI {
  get: () => Promise<PersistentStatistics>
  getToday: () => Promise<DailyStatistics>
}

interface TrayAPI {
  openDashboard: () => void
  setHeight: (height: number) => void
  quitApp: () => void
}

interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

interface ManagementApiAPI {
  getConfig: () => Promise<ManagementApiConfig>
  updateConfig: (updates: Partial<ManagementApiConfig>) => Promise<boolean>
  generateSecret: () => Promise<string>
}

interface StrategyConfig {
  slidingWindow: {
    enabled: boolean
    maxMessages: number
  }
  tokenLimit: {
    enabled: boolean
    maxTokens: number
  }
  summary: {
    enabled: boolean
    keepRecentMessages: number
    summaryPrompt?: string
  }
}

interface ContextManagementConfig {
  enabled: boolean
  strategies: StrategyConfig
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

interface ContextManagementAPI {
  getConfig: () => Promise<ContextManagementConfig>
  updateConfig: (updates: Partial<ContextManagementConfig>) => Promise<ContextManagementConfig>
}

interface ToolCallingAPI {
  getStatus: () => Promise<unknown>
  runSmoke: (input: { clientAdapterId: string }) => Promise<{ success: boolean; data?: unknown; error?: { message?: string } }>
}

interface ElectronAPI {
  inference: import('../../../shared/inference').InternalInferenceAPI
  terminal: import('../../../shared/terminal').TerminalManagerAPI
  companion: import('../../../shared/companion').CompanionAPI
  getPathForFile: (file: File) => string
  proxy: ProxyAPI
  store: StoreAPI
  providers: ProvidersAPI
  ollama: OllamaAPI
  accounts: AccountsAPI
  oauth: OAuthAPI
  logs: LogsAPI
  requestLogs: RequestLogsAPI
  statistics: StatisticsAPI
  app: AppAPI
  config: ConfigAPI
  prompts: PromptsAPI
  session: SessionAPI
  managementApi: ManagementApiAPI
  contextManagement: ContextManagementAPI
  toolCalling: ToolCallingAPI
  tray: TrayAPI
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  send: (channel: string, ...args: unknown[]) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
