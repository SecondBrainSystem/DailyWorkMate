import { normalizeModelFeatureDefaults } from '../../shared/modelFeatures'
import { normalizeTypography, validateTypography } from '../../shared/typography'
import { accountUsageDate, normalizeAccountDailyUsage } from './accountUsage'
import { isOllamaModelUsable } from '../../shared/ollamaAvailability'

/**
 * Credential Storage Module - Core Storage Implementation
 * Uses electron-store for persistent storage
 * Uses Electron's safeStorage API for sensitive data encryption
 */

import { app, safeStorage, BrowserWindow } from 'electron'
import { internalProxyKey } from '../proxy/internalAuth'
import { localDateKey } from '../../shared/localDate'
import { MIN_USAGE_HISTORY_DAYS, usageHistoryStart } from '../../shared/usageHistory'
import { redactSecrets } from '../../shared/redaction'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  LogLevel,
  SystemPrompt,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  RequestLogConfig,
  PersistentStatistics,
  DailyStatistics,
  DEFAULT_STATISTICS,
  EffectiveModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
  DEFAULT_REQUEST_LOG_CONFIG,
  createDefaultModelMappings,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
  migrateLegacyProxyPort,
} from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'
import { RequestLogManager } from '../requestLogs/manager'
import { normalizeRequestLogConfig } from '../requestLogs/types'
import { normalizeToolCallingConfig } from '../../shared/toolCalling'
import { AppLogManager } from '../appLogs/manager'
import type { AppLogFilter } from '../appLogs/types'
import { networkExposureError } from '../../shared/proxyListeners'
import { cachedStore } from './cachedStore'
import { providerFromBuiltin, refreshBuiltinProvider } from '../providers/builtin/index.ts'

// Dynamically import electron-store (ESM module)
let Store: any = null

interface PendingAccountUsage {
  readonly requests: number
  readonly lastUsed: number
  /** Local date the requests count toward (accountUsageDate). */
  readonly usageDate: string
  readonly reactivate: boolean
}

/** Client-chosen model names must not grow statistics without bound. */
const MAX_STAT_MODEL_KEYS = 200
const OTHER_MODELS_KEY = 'other'

function statModelKey(usage: Record<string, number>, model: string): string {
  const key = model.slice(0, 200)
  return key in usage || Object.keys(usage).length < MAX_STAT_MODEL_KEYS ? key : OTHER_MODELS_KEY
}

function emptyDailyStatistics(date: string): DailyStatistics {
  return { date, totalRequests: 0, successRequests: 0, failedRequests: 0, totalLatency: 0, modelUsage: {}, totalTokens: 0, modelTokenUsage: {}, providerUsage: {} }
}

/**
 * Storage Instance Type Definition
 */
type StoreType = any

/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 */
export class StoreManager {
  private store: StoreType | null = null
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null
  private initializationError: Error | null = null
  private requestLogManager: RequestLogManager | null = null
  private appLogManager: AppLogManager | null = null
  private keyUsage = new Map<string, { count: number; lastUsedAt: number }>()
  private keyUsageTimer?: NodeJS.Timeout
  // Every store write re-encrypts (PBKDF2) and rewrites the whole file on the main thread, so
  // per-request counters live in memory and reach disk in one write at most every USAGE_FLUSH_MS.
  private pendingAccountUsage: ReadonlyMap<string, PendingAccountUsage> = new Map()
  private pendingStatistics?: PersistentStatistics
  private usageTimer?: NodeJS.Timeout
  private static readonly USAGE_FLUSH_MS = 2000
  private configMemo?: { version: number; config: AppConfig }
  private effectiveModelsMemo?: { version: number; models: ReadonlyMap<string, readonly EffectiveModel[]> }
  // safeStorage decryption is a synchronous OS call; ciphertexts are unique per encryption, so the
  // ciphertext is a safe cache key that changes whenever a credential is rewritten.
  private decryptedValues: ReadonlyMap<string, string> = new Map()
  private static readonly MAX_DECRYPTED_VALUES = 1024
  recordApiKeyUsage(id: string) {
    const previous = this.keyUsage.get(id)
    this.keyUsage = new Map([...this.keyUsage, [id, { count: (previous?.count || 0) + 1, lastUsedAt: Date.now() }]])
    if (!this.keyUsageTimer) { this.keyUsageTimer = setTimeout(() => this.flushApiKeyUsage(), 2000); this.keyUsageTimer.unref() }
  }
  private flushApiKeyUsage() {
    clearTimeout(this.keyUsageTimer); this.keyUsageTimer = undefined
    if (!this.store || !this.keyUsage.size) return
    const config = this.getConfig(); this.keyUsage = new Map()
    this.store.set('config', config)
  }

  /** Store version for memoization; undefined for plain stores (tests) so nothing is memoized. */
  private storeVersion(): number | undefined {
    const version = this.store?.version
    return typeof version === 'number' ? version : undefined
  }

  /** Read without copying when the cache supports it. The result is shared: never mutate it. */
  private peek<T>(key: string): T | undefined {
    return typeof this.store?.peek === 'function' ? this.store.peek(key) as T | undefined : this.store?.get(key) as T | undefined
  }

  /** Normalized config shared by every reader of one store version. Never mutate the result. */
  private storedConfig(): AppConfig {
    const version = this.storeVersion()
    if (version !== undefined && this.configMemo?.version === version) return this.configMemo.config
    const config = this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
    if (version !== undefined) this.configMemo = { version, config }
    return config
  }

  private applyPendingUsage(account: Account, pending = this.pendingAccountUsage.get(account.id)): Account {
    if (!pending) return account
    return {
      ...account,
      ...(pending.reactivate ? { status: 'active' as const, errorMessage: undefined } : {}),
      lastUsed: Math.max(account.lastUsed || 0, pending.lastUsed),
      requestCount: (account.requestCount || 0) + pending.requests,
      todayUsed: (account.todayUsed || 0) + (account.dailyUsageDate === pending.usageDate ? pending.requests : 0),
    }
  }

  /** Accounts as callers should see them: daily quota normalized and unflushed usage applied. */
  private readAccounts(): Account[] {
    const now = Date.now()
    return (this.peek<Account[]>('accounts') || []).map(account => this.applyPendingUsage(normalizeAccountDailyUsage(account, now)))
  }

  private withCredentials(account: Account, includeCredentials: boolean): Account {
    return { ...account, credentials: includeCredentials ? this.decryptCredentials(account.credentials || {}) : { ...(account.credentials || {}) } }
  }

  private scheduleUsageFlush(): void {
    if (this.usageTimer) return
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined
      try { this.flushUsage() } catch (error) {
        console.error('[Store] Failed to save usage counters:', error)
      }
    }, StoreManager.USAGE_FLUSH_MS)
    this.usageTimer.unref?.()
  }

  /** Persist buffered account counters and statistics in at most two writes. */
  flushUsage(): void {
    clearTimeout(this.usageTimer); this.usageTimer = undefined
    if (!this.store) return
    if (this.pendingAccountUsage.size) {
      const pending = this.pendingAccountUsage
      this.pendingAccountUsage = new Map()
      const now = Date.now()
      const accounts = (this.store.get('accounts') as Account[] | undefined) || []
      this.store.set('accounts', accounts.map(account => pending.has(account.id)
        ? { ...this.applyPendingUsage(normalizeAccountDailyUsage(account, now), pending.get(account.id)), updatedAt: now }
        : account))
    }
    if (this.pendingStatistics) {
      const statistics = this.withoutExpiredDailyStats(this.pendingStatistics)
      this.pendingStatistics = undefined
      this.store.set('statistics', statistics)
    }
  }

  /**
   * Count one completed request for an account without a synchronous store write.
   * `reactivate` restores an Ollama node account that a successful request proved healthy.
   */
  recordAccountUsage(accountId: string, options: { reactivate?: boolean } = {}): void {
    this.ensureInitialized()
    const usageDate = accountUsageDate()
    const previous = this.pendingAccountUsage.get(accountId)
    // Counters for an earlier day must land on that day before today's start.
    if (previous && previous.usageDate !== usageDate) this.flushUsage()
    const base = this.pendingAccountUsage.get(accountId)
    this.pendingAccountUsage = new Map([...this.pendingAccountUsage, [accountId, {
      requests: (base?.requests || 0) + 1,
      lastUsed: Date.now(),
      usageDate,
      reactivate: Boolean(base?.reactivate || options.reactivate),
    }]])
    this.scheduleUsageFlush()
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Check if storage has initialization error
   */
  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  /**
   * Get initialization error
   */
  getInitializationError(): Error | null {
    return this.initializationError
  }

  /**
   * Initialize Storage
   * Create storage instance and initialize default data
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Dynamically import electron-store (ESM module)
    if (!Store) {
      const module = await import('electron-store')
      Store = module.default
    }

    const storagePath = this.getStoragePath()

    try {
      this.store = cachedStore(new Store({
        name: 'data',
        cwd: storagePath,
        defaults: this.getDefaultData(),
        encryptionKey: this.getEncryptionKey(),
      }))

      // Legacy files cannot prove whether absent dates were idle or already pruned.
      // Preserve every retained day, and record zero-usage coverage prospectively.
      const statistics = this.store.get('statistics') || DEFAULT_STATISTICS
      if (!usageHistoryStart(statistics.dailyStatsAvailableFrom)) {
        this.store.set('statistics', { ...statistics, dailyStatsAvailableFrom: localDateKey() })
      }

      await this.initializeAppLogManager(storagePath)
      await this.initializeRequestLogManager(storagePath)
      this.initializeDefaultModelMappings()
      await this.initializeDefaultProviders()
      this.isInitialized = true
      this.initializationError = null
    } catch (error) {
      console.error('[Store] Failed to initialize storage:', error)
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      
      // A keyring or disk error is not proof of corruption. Preserve all account data.
      this.store = null
      throw this.initializationError
    }
  }

  /**
   * Recover from corrupted data file
   * Backup the corrupted file and create a new one
   */
  private async recoverFromCorruptedData(storagePath: string): Promise<void> {
    const { renameSync, existsSync } = await import('fs')
    const { join } = await import('path')
    
    const dataPath = join(storagePath, 'data.json')
    const backupPath = join(storagePath, `data.corrupted.${Date.now()}.json`)
    
    if (existsSync(dataPath)) {
      console.log('[Store] Backing up corrupted data file to:', backupPath)
      try {
        renameSync(dataPath, backupPath)
        console.log('[Store] Corrupted data file backed up successfully')
      } catch (backupError) {
        console.error('[Store] Failed to backup corrupted data:', backupError)
        throw backupError
      }
    }
  }

  /**
   * Get Storage Path
   * Storage path: ~/.dailyworkmate/
   */
  private getStoragePath(): string {
    return join(homedir(), '.dailyworkmate')
  }

  /**
   * Get Encryption Key
   * Returns a fixed encryption key for electron-store
   * Note: electron-store uses this key to encrypt/decrypt the data file,
   * so it must be stable across app restarts
   */
  private getEncryptionKey(): string | undefined {
    const file = join(this.getStoragePath(), 'data.json')
    // Detect the legacy plaintext file independently of OS keyring availability.
    if (existsSync(file) && readFileSync(file, 'utf8').trimStart().startsWith('{')) return undefined
    // Legacy encryption identity must remain stable for existing account files.
    return 'chat2api-fixed-encryption-key-v1'
  }

  /**
   * Get Default Data Structure
   */
  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: { ...DEFAULT_CONFIG, language: app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US' },
      logs: [],
      requestLogs: [],
      systemPrompts: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  private requestLogListeners: ReadonlySet<(entry: RequestLogEntry) => void> = new Set()

  /** Subscribe to added or updated request logs (bodies omitted); works before initialization. */
  onRequestLogChanged(listener: (entry: RequestLogEntry) => void): () => void {
    this.requestLogListeners = new Set([...this.requestLogListeners, listener])
    return () => { this.requestLogListeners = new Set([...this.requestLogListeners].filter(item => item !== listener)) }
  }

  private async initializeRequestLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.requestLogManager = new RequestLogManager({
      storageDir: join(storagePath, 'request-logs'),
      config: config.requestLogConfig,
    })
    this.requestLogManager.onLogChanged(entry => {
      for (const listener of this.requestLogListeners) listener(entry)
    })
    this.requestLogManager.setRetentionDays(config.logRetentionDays)
    await this.requestLogManager.initialize()

    const legacyRequestLogs = this.store?.get('requestLogs') || []
    if (legacyRequestLogs.length > 0) {
      await this.requestLogManager.migrateLegacyLogs(legacyRequestLogs)
      this.store?.set('requestLogs', [])
    }
  }

  private async initializeAppLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.appLogManager = new AppLogManager({
      storageDir: join(storagePath, 'logs'),
      maxEntries: this.getMaxLogEntries(config),
    })
    this.appLogManager.setRetentionDays(config.logRetentionDays)
    await this.appLogManager.initialize()

    const legacyLogs = this.store?.get('logs') || []
    if (legacyLogs.length > 0) {
      await this.appLogManager.migrateLegacyLogs(legacyLogs)
      this.appLogManager.flushSync()
      this.store?.set('logs', [])
    }
  }

  private getMaxLogEntries(config: AppConfig): number {
    return config.logRetentionDays * 1000
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const migratedConfig = migrateLegacyProxyPort(config)
    const rawConfig = {
      ...DEFAULT_CONFIG,
      ...migratedConfig,
    }
    const rawToolCallingConfig = rawConfig.toolCallingConfig ?? rawConfig.toolPromptConfig

    return {
      ...rawConfig,
      uiTypography: normalizeTypography(rawConfig.uiTypography),
      modelFeatureDefaults: normalizeModelFeatureDefaults(rawConfig.modelFeatureDefaults),
      modelMappings: normalizeModelMappingsWithDefaults(rawConfig.modelMappings),
      ollamaRouting: {
        ...DEFAULT_CONFIG.ollamaRouting,
        ...(rawConfig.ollamaRouting || {}),
      },
      defaultModelMappingsSeeded: migratedConfig.defaultModelMappingsSeeded,
      requestLogConfig: normalizeRequestLogConfig(
        rawConfig.requestLogConfig || DEFAULT_REQUEST_LOG_CONFIG,
      ),
      toolCallingConfig: normalizeToolCallingConfig(rawToolCallingConfig),
      toolPromptConfig: undefined,
    }
  }

  private initializeDefaultModelMappings(): void {
    const rawConfig = this.store?.get('config') || DEFAULT_CONFIG
    const config = this.normalizeConfig(rawConfig)
    if (config.defaultModelMappingsSeeded) {
      this.store?.set('config', config)
      return
    }
    this.store?.set('config', this.normalizeConfig({
      ...config,
      modelMappings: {
        ...createDefaultModelMappings(),
        ...(config.modelMappings || {}),
      },
      defaultModelMappingsSeeded: true,
    }))
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.store?.get('providers') || []
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    
    const validProviders = providers.map((p: Provider): Provider => p.type === 'builtin' && !builtinIds.includes(p.id) ? { ...p, type: 'custom' } : p)
    
    const userModelOverrides: UserModelOverrides = {
      ...(this.store?.get('userModelOverrides') || {}),
    }
    let userModelOverridesChanged = false
    
    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
        if (builtinConfig) {
          if (p.id === 'deepseek') {
            const sanitizedOverrides = sanitizeDeepSeekModelOverrides(userModelOverrides[p.id])
            if (JSON.stringify(sanitizedOverrides) !== JSON.stringify(userModelOverrides[p.id])) {
              userModelOverrides[p.id] = sanitizedOverrides
              userModelOverridesChanged = true
            }
          }

          return refreshBuiltinProvider(p, builtinConfig)
        }
      }
      return p
    })
    
    if (userModelOverridesChanged) {
      this.store?.set('userModelOverrides', userModelOverrides)
    }
    this.store?.set('providers', updatedProviders)
  }

  /**
   * Ensure provider exists, create if not
   */
  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const exists = providers.some((p: Provider) => p.id === providerId)
    
    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
      if (builtinConfig) {
        this.store!.set('providers', [...providers, providerFromBuiltin(builtinConfig)])
        console.log('[Store] Created missing provider:', providerId)
      }
    }
  }

  /**
   * Ensure Storage is Initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store) {
      const errorMsg = this.initializationError 
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 10
      case 'info':
        return 20
      case 'warn':
        return 30
      case 'error':
        return 40
      default:
        return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.storedConfig()
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  private getCombinedLogs(): LogEntry[] {
    return this.getAppLogManager().exportLogs()
  }

  flushPendingWrites(): void {
    this.flushApiKeyUsage()
    this.flushUsage()
    this.appLogManager?.flushSync()
    this.requestLogManager?.flushSync()
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(safeStorage.encryptString(data))
        return encrypted.toString('base64')
      }
    } catch (error) {
      console.error('Failed to encrypt data:', error)
    }
    return data
  }

  /**
   * Decrypt Sensitive Data
   * @param encryptedData Encrypted data
   * @returns Decrypted string
   */
  decryptData(encryptedData: string): string {
    const cached = this.decryptedValues.get(encryptedData)
    if (cached !== undefined) return cached
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedData, 'base64')
        const decrypted = safeStorage.decryptString(buffer)
        const retained = this.decryptedValues.size >= StoreManager.MAX_DECRYPTED_VALUES ? [] : [...this.decryptedValues]
        this.decryptedValues = new Map([...retained, [encryptedData, decrypted]])
        return decrypted
      }
    } catch (error) {
      console.error('Failed to decrypt data:', error)
    }
    return encryptedData
  }

  /**
   * Encrypt Credentials Object
   * @param credentials Credentials object
   * @returns Encrypted credentials object
   */
  encryptCredentials(credentials: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}
    
    for (const [key, value] of Object.entries(credentials)) {
      encrypted[key] = this.encryptData(value)
    }
    
    return encrypted
  }

  /**
   * Decrypt Credentials Object
   * @param encryptedCredentials Encrypted credentials object
   * @returns Decrypted credentials object
   */
  decryptCredentials(encryptedCredentials: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}
    
    for (const [key, value] of Object.entries(encryptedCredentials)) {
      decrypted[key] = this.decryptData(value)
    }
    
    return decrypted
  }

  // ==================== Provider Operations ====================

  /**
   * Get All Providers
   */
  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.store!.get('providers') || []
  }

  /**
   * Get Provider By ID
   */
  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    // Copy only the requested provider; Ollama catalogs make the full list large.
    const provider = (this.peek<Provider[]>('providers') || []).find((p: Provider) => p.id === id)
    return provider ? structuredClone(provider) : undefined
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    this.store!.set('providers', [...providers, provider])
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    const updated: Provider = {
      ...providers[index],
      ...updates,
      updatedAt: Date.now(),
    }

    this.store!.set('providers', providers.map((provider, position) => position === index ? updated : provider))
    return updated
  }

  /**
   * Delete Provider
   */
  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    this.store!.set('providers', providers.filter((provider: Provider) => provider.id !== id))

    const accounts = this.store!.get('accounts') as Account[] || []
    const removed = new Set(accounts.filter((a: Account) => a.providerId === id).map(account => account.id))
    this.pendingAccountUsage = new Map([...this.pendingAccountUsage].filter(([accountId]) => !removed.has(accountId)))
    this.store!.set('accounts', accounts.filter((a: Account) => a.providerId !== id))
    
    return true
  }

  // ==================== Model Overrides Operations ====================

  /**
   * Get Model Overrides for a Provider
   * Returns user customizations to built-in provider models
   */
  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  /**
   * Check if Provider has Model Overrides
   * Returns true if provider has user-added models or excluded models
   */
  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false
    
    return (
      (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
    )
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    return this.readAccounts().map(account => this.withCredentials(account, includeCredentials))
  }

  /**
   * Get Account By ID
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const account = (this.peek<Account[]>('accounts') || []).find((a: Account) => a.id === id)
    return account ? this.withCredentials(this.applyPendingUsage(normalizeAccountDailyUsage(account)), includeCredentials) : undefined
  }

  /**
   * Get Accounts By Provider ID
   */
  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const now = Date.now()
    return (this.peek<Account[]>('accounts') || [])
      .filter((a: Account) => a.providerId === providerId)
      .map(account => this.withCredentials(this.applyPendingUsage(normalizeAccountDailyUsage(account, now)), includeCredentials))
  }

  /**
   * Add Account
   * Credentials are automatically encrypted before storage
   */
  addAccount(account: Account): void {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    
    this.store!.set('accounts', [...accounts, encryptedAccount])
  }

  /**
   * Update Account
   */
  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    // Explicit writes start from materialized counters so buffered usage is neither lost nor counted twice.
    if (this.pendingAccountUsage.has(id)) this.flushUsage()
    const accounts = ((this.store!.get('accounts') as Account[]) || []).map(account => normalizeAccountDailyUsage(account))
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return null
    }
    
    const updatedAccount: Account = {
      ...accounts[index],
      ...updates,
      updatedAt: Date.now(),
      ...(updates.credentials ? { credentials: this.encryptCredentials(updates.credentials) } : {}),
    }

    this.store!.set('accounts', accounts.map((account, position) => position === index ? updatedAccount : account))
    
    return {
      ...updatedAccount,
      credentials: updates.credentials || this.decryptCredentials(accounts[index].credentials),
    }
  }

  /**
   * Delete Account
   */
  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = ((this.store!.get('accounts') as Account[]) || []).map(account => normalizeAccountDailyUsage(account))
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return false
    }
    
    this.pendingAccountUsage = new Map([...this.pendingAccountUsage].filter(([accountId]) => accountId !== id))
    this.store!.set('accounts', accounts.filter(account => account.id !== id))
    return true
  }

  /**
   * Get Active Accounts
   */
  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    return this.readAccounts()
      .filter((a: Account) => a.status === 'active')
      .map(account => this.withCredentials(account, includeCredentials))
  }

  // ==================== Configuration Operations ====================

  /**
   * Get Application Configuration
   */
  getConfig(): AppConfig {
    this.ensureInitialized()
    // Callers may change what they receive, so hand out a copy of the shared normalized config.
    const config = structuredClone(this.storedConfig())
    return { ...config, apiKeys: config.apiKeys.map(key => {
      const usage = this.keyUsage.get(key.id)
      return usage ? { ...key, usageCount: (key.usageCount || 0) + usage.count, lastUsedAt: usage.lastUsedAt } : key
    }) }
  }

  /**
   * Set Application Configuration
   */
  private broadcastConfig(config: AppConfig): void {
    if (!this.mainWindow) return
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('config:changed', { ...config, internalProxyKey })
  }
  setConfig(config: Partial<AppConfig>): void {
    this.ensureInitialized()
    if (config.uiTypography !== undefined) validateTypography(config.uiTypography)
    const normalized = this.normalizeConfig(config)
    this.store!.set('config', normalized)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(normalized))
    this.appLogManager?.setRetentionDays(normalized.logRetentionDays)
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
    this.requestLogManager?.setRetentionDays(normalized.logRetentionDays)
  }

  /**
   * Update Application Configuration
   */
  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    if (updates.uiTypography !== undefined) validateTypography(updates.uiTypography)
    const currentConfig = this.getConfig()
    // Every writer (settings UI, management API key routes, imports) passes through here. Only a
    // change that removes protection is refused; an already unprotected setup stays editable so it can be fixed.
    const exposure = networkExposureError({ ...currentConfig, ...updates })
    if (exposure && !networkExposureError(currentConfig)) throw new Error(exposure)
    const newConfig = {
      ...currentConfig,
      ...updates,
      apiKeys: (updates.apiKeys || currentConfig.apiKeys).map(key => {
        const existing = currentConfig.apiKeys.find(item => item.id === key.id)
        return { ...key, usageCount: Math.max(key.usageCount || 0, existing?.usageCount || 0), lastUsedAt: Math.max(key.lastUsedAt || 0, existing?.lastUsedAt || 0) || undefined }
      }),
      internalProxyKey: undefined,
    }
    clearTimeout(this.keyUsageTimer); this.keyUsageTimer = undefined; this.keyUsage = new Map()
    
    // Deep merge for nested objects
    if (updates.modelFeatureDefaults) {
      newConfig.modelFeatureDefaults = normalizeModelFeatureDefaults({
        ...currentConfig.modelFeatureDefaults,
        ...updates.modelFeatureDefaults,
      })
    }
    if (updates.toolCallingConfig || updates.toolPromptConfig) {
      const incoming = updates.toolCallingConfig ?? updates.toolPromptConfig
      const incomingRecord = incoming && typeof incoming === 'object' ? incoming as Record<string, unknown> : {}
      const incomingAdvanced = incomingRecord.advanced && typeof incomingRecord.advanced === 'object'
        ? incomingRecord.advanced as Record<string, unknown>
        : {}

      newConfig.toolCallingConfig = normalizeToolCallingConfig({
        ...currentConfig.toolCallingConfig,
        ...incomingRecord,
        advanced: {
          ...currentConfig.toolCallingConfig.advanced,
          ...incomingAdvanced,
        },
      })
      newConfig.toolPromptConfig = undefined
    }
    
    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = {
        ...currentConfig.sessionConfig,
        ...updates.sessionConfig,
      }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    const normalized = this.normalizeConfig(newConfig)
    this.store!.set('config', normalized)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(normalized))
    this.requestLogManager?.setConfig(normalized.requestLogConfig)
    this.requestLogManager?.setRetentionDays(normalized.logRetentionDays)
    this.appLogManager?.setRetentionDays(normalized.logRetentionDays)
    this.broadcastConfig(normalized)
    return normalized
  }

  /**
   * Reset Configuration to Default Values
   */
  resetConfig(): AppConfig {
    this.ensureInitialized()
    const config: AppConfig = { ...DEFAULT_CONFIG, language: app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US' }
    this.store!.set('config', config)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(config))
    this.appLogManager?.setRetentionDays(config.logRetentionDays)
    this.requestLogManager?.setConfig(config.requestLogConfig)
    this.requestLogManager?.setRetentionDays(config.logRetentionDays)
    this.broadcastConfig(config)
    return config
  }

  // ==================== Log Operations ====================

  /**
   * Add Log Entry
   */
  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
      model?: string
      actualModel?: string
      latency?: number
      isStream?: boolean
      error?: string
    }
  ): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message: String(redactSecrets(message)),
      ...redactSecrets(data) as typeof data,
    }

    if (!this.shouldRecordLog(level)) {
      return entry
    }

    this.getAppLogManager().addLog(entry)

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(filter?: AppLogFilter): LogEntry[] {
    this.ensureInitialized()
    return this.getAppLogManager().getLogs(filter)
  }

  /**
   * Clear Logs
   */
  clearLogs(): void {
    this.ensureInitialized()
    this.getAppLogManager().clearLogs()
    this.store!.set('logs', [])
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.getAppLogManager().replaceLogs(logs)
    this.store!.set('logs', [])
  }

  /**
   * Get Log Statistics
   */
  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    return this.getAppLogManager().getStats()
  }

  /**
   * Get Log Trend
   */
  getLogTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getTrend(days)
  }

  /**
   * Get Log Trend for specific account
   * Only counts successful API requests (logs with requestId) to match requestCount
   */
  getAccountLogTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.getAppLogManager().getAccountTrend(accountId, days)
  }

  /**
   * Export Logs
   */
  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map((log: LogEntry) => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`
        
        if (log.providerId) {
          line += ` | Provider: ${log.providerId}`
        }
        if (log.accountId) {
          line += ` | Account: ${log.accountId}`
        }
        if (log.requestId) {
          line += ` | Request: ${log.requestId}`
        }
        if (log.data) {
          line += ` | Data: ${JSON.stringify(log.data)}`
        }
        
        return line
      })
      .join('\n')
  }

  /**
   * Get Log By ID
   */
  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()
    return logs.find((l: LogEntry) => l.id === id)
  }

  /**
   * Clear Expired Logs
   */
  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.getCombinedLogs()
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000
    
    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.getAppLogManager().replaceLogs(filtered)
    this.store!.set('logs', [])
  }

  // ==================== Request Log Operations ====================

  /**
   * Add Request Log Entry
   */
  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    const newEntry = this.getRequestLogManager().addRequestLog(entry)
    return newEntry
  }

  /**
   * Update Request Log Entry
   */
  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.getRequestLogManager().updateRequestLog(id, updates)
  }

  /**
   * Get Request Logs
   */
  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string; keyword?: string; offset?: number; summaryOnly?: boolean }): RequestLogEntry[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogs(limit, filter)
  }

  /**
   * Get Request Log By ID
   */
  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogById(id)
  }

  /**
   * Clear Request Logs
   */
  clearRequestLogs(): void {
    this.ensureInitialized()
    this.getRequestLogManager().clearRequestLogs()
  }

  /**
   * Get Request Log Statistics
   */
  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogStats()
  }

  /**
   * Get Request Log Trend
   */
  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const count = Number.isFinite(days) ? Math.max(1, Math.min(365, Math.floor(days))) : 7
    return Array.from({ length: count }, (_, i) => {
      const date = new Date(); date.setDate(date.getDate() - (count - 1 - i)); const key = localDateKey(date)
      const day = stats.dailyStats[key]
      return { date: key, total: day?.totalRequests || 0, success: day?.successRequests || 0, error: day?.failedRequests || 0, avgLatency: day?.successRequests ? Math.round(day.totalLatency / day.successRequests) : 0 }
    })
  }

  // ==================== Statistics Operations ====================

  /**
   * Get Persistent Statistics
   */
  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    const stored = this.pendingStatistics ? structuredClone(this.pendingStatistics) : this.store!.get('statistics') || DEFAULT_STATISTICS
    return {
      ...DEFAULT_STATISTICS,
      ...stored,
      dailyStatsAvailableFrom: usageHistoryStart(stored.dailyStatsAvailableFrom) || localDateKey(),
      modelUsage: { ...(stored.modelUsage || {}) },
      modelTokenUsage: { ...(stored.modelTokenUsage || {}) },
      providerUsage: { ...(stored.providerUsage || {}) },
      accountUsage: { ...(stored.accountUsage || {}) },
      dailyStats: { ...(stored.dailyStats || {}) },
    }
  }

  /**
   * Update Statistics
   */
  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    this.flushUsage()
    const currentStats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Record Request in Statistics
   */
  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const today = localDateKey()
    const increment = (usage: Record<string, number>, key: string) => ({ ...usage, [key]: (usage[key] || 0) + 1 })
    const existingDay: DailyStatistics = stats.dailyStats[today] || emptyDailyStatistics(today)
    const dayModelUsage = existingDay.modelUsage || {}
    const day: DailyStatistics = {
      ...existingDay,
      totalRequests: existingDay.totalRequests + 1,
      successRequests: existingDay.successRequests + (success ? 1 : 0),
      failedRequests: existingDay.failedRequests + (success ? 0 : 1),
      totalLatency: existingDay.totalLatency + (success ? latency : 0),
      modelUsage: model ? increment(dayModelUsage, statModelKey(dayModelUsage, model)) : { ...dayModelUsage },
      providerUsage: providerId ? increment(existingDay.providerUsage || {}, providerId) : { ...(existingDay.providerUsage || {}) },
    }
    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: model ? increment(stats.modelUsage, statModelKey(stats.modelUsage, model)) : stats.modelUsage,
      providerUsage: providerId ? increment(stats.providerUsage, providerId) : stats.providerUsage,
      accountUsage: accountId ? increment(stats.accountUsage, accountId) : stats.accountUsage,
      dailyStats: { ...stats.dailyStats, [today]: day },
    }
    this.pendingStatistics = newStats
    this.scheduleUsageFlush()
    return structuredClone(newStats)
  }

  /**
   * Record token usage after a response body or stream has completed.
   */
  recordTokenUsage(model: string, totalTokens: number): PersistentStatistics {
    this.ensureInitialized()
    const tokens = Number.isFinite(totalTokens) ? Math.max(0, Math.floor(totalTokens)) : 0
    if (!model || tokens === 0) return this.getStatistics()

    const stats = this.getStatistics()
    const today = localDateKey()
    const existingDay = stats.dailyStats[today] || emptyDailyStatistics(today)
    const dayTokens = existingDay.modelTokenUsage || {}
    const totalModelTokens = stats.modelTokenUsage || {}
    const dayKey = statModelKey(dayTokens, model)
    const totalKey = statModelKey(totalModelTokens, model)
    const day: DailyStatistics = {
      ...existingDay,
      modelUsage: { ...(existingDay.modelUsage || {}) },
      totalTokens: (existingDay.totalTokens || 0) + tokens,
      modelTokenUsage: { ...dayTokens, [dayKey]: (dayTokens[dayKey] || 0) + tokens },
      providerUsage: { ...(existingDay.providerUsage || {}) },
    }
    const next: PersistentStatistics = {
      ...stats,
      totalTokens: (stats.totalTokens || 0) + tokens,
      modelTokenUsage: { ...totalModelTokens, [totalKey]: (totalModelTokens[totalKey] || 0) + tokens },
      dailyStats: { ...stats.dailyStats, [today]: day },
      lastUpdated: Date.now(),
    }
    this.pendingStatistics = next
    this.scheduleUsageFlush()
    return structuredClone(next)
  }

  /**
   * Get Today Statistics
   */
  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const today = localDateKey()
    const day = stats.dailyStats[today]
    return day ? {
      ...day,
      modelUsage: { ...(day.modelUsage || {}) },
      totalTokens: day.totalTokens || 0,
      modelTokenUsage: { ...(day.modelTokenUsage || {}) },
      providerUsage: { ...(day.providerUsage || {}) },
    } : {
      date: today,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      modelUsage: {},
      totalTokens: 0,
      modelTokenUsage: {},
      providerUsage: {},
    }
  }

  /**
   * Clean daily aggregates while retaining both monitor comparison periods.
   */
  cleanOldDailyStats(): void {
    this.ensureInitialized()
    this.flushUsage()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const filtered = this.withoutExpiredDailyStats(stats)
    if (filtered.dailyStatsAvailableFrom !== stats.dailyStatsAvailableFrom || Object.keys(filtered.dailyStats).length !== Object.keys(stats.dailyStats || {}).length) {
      this.store!.set('statistics', filtered)
    }
  }

  /** Aggregates outlive detailed logs; never claim coverage for days already pruned. */
  private withoutExpiredDailyStats(stats: PersistentStatistics): PersistentStatistics {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - Math.max(MIN_USAGE_HISTORY_DAYS, this.storedConfig().logRetentionDays) + 1)
    const cutoffDate = localDateKey(cutoff)
    const availableFrom = usageHistoryStart(stats.dailyStatsAvailableFrom) || localDateKey()
    return {
      ...stats,
      dailyStatsAvailableFrom: availableFrom > cutoffDate ? availableFrom : cutoffDate,
      dailyStats: Object.fromEntries(Object.entries(stats.dailyStats || {}).filter(([date]) => date >= cutoffDate)),
    }
  }

  // ==================== System Prompts Operations ====================

  /**
   * Get All System Prompts
   * Merges built-in prompts with custom prompts
   */
  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const storedPrompts = this.store!.get('systemPrompts') || []
    const builtinIds = new Set(BUILTIN_PROMPTS.map(prompt => prompt.id))
    const builtins = BUILTIN_PROMPTS.map(builtin => {
      const override = storedPrompts.find((prompt: SystemPrompt) => prompt.id === builtin.id)
      return override
        ? { ...builtin, ...override, id: builtin.id, isBuiltin: true, createdAt: builtin.createdAt }
        : builtin
    })
    const customPrompts = storedPrompts.filter((prompt: SystemPrompt) => !builtinIds.has(prompt.id))
    return [...builtins, ...customPrompts]
  }

  /**
   * Get Built-in System Prompts
   */
  getBuiltinPrompts(): SystemPrompt[] {
    return this.getSystemPrompts().filter(prompt => prompt.isBuiltin)
  }

  /**
   * Get Custom System Prompts
   */
  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const builtinIds = new Set(BUILTIN_PROMPTS.map(prompt => prompt.id))
    return (this.store!.get('systemPrompts') || [])
      .filter((prompt: SystemPrompt) => !builtinIds.has(prompt.id))
  }

  /**
   * Get System Prompt By ID
   */
  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find(p => p.id === id)
  }

  /**
   * Add Custom System Prompt
   */
  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    const prompts = this.store!.get('systemPrompts') || []
    
    const newPrompt: SystemPrompt = {
      ...prompt,
      id: this.generateId(),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    this.store!.set('systemPrompts', [...prompts, newPrompt])
    
    return newPrompt
  }

  /**
   * Update a system prompt. Built-in prompt edits are stored as user overrides.
   */
  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    const builtin = BUILTIN_PROMPTS.find(prompt => prompt.id === id)
    
    if (index === -1 && !builtin) {
      return null
    }

    const current = index >= 0 ? prompts[index] : builtin!
    const updated: SystemPrompt = {
      ...current,
      ...updates,
      id: current.id,
      isBuiltin: Boolean(builtin),
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }

    this.store!.set('systemPrompts', index >= 0
      ? prompts.map((prompt: SystemPrompt, position: number) => position === index ? updated : prompt)
      : [...prompts, updated])
    return updated
  }

  /**
   * Delete Custom System Prompt
   * Cannot delete built-in prompts
   */
  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()
    
    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot delete built-in prompt:', id)
      return false
    }
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    
    if (index === -1) {
      return false
    }

    this.store!.set('systemPrompts', prompts.filter((prompt: SystemPrompt) => prompt.id !== id))
    
    return true
  }

  /**
   * Get System Prompts By Type
   */
  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter(p => p.type === type)
  }

  // ==================== Session Operations ====================

  /**
   * Get Session Configuration
   */
  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.store!.get('config') || DEFAULT_CONFIG
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  /**
   * Update Session Configuration
   */
  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.store!.get('config') || DEFAULT_CONFIG
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    const newConfig = {
      ...currentConfig,
      sessionConfig: newSessionConfig,
    }
    this.store!.set('config', newConfig)
    return newSessionConfig
  }

  /**
   * Get All Sessions
   */
  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.store!.get('sessions') || []
  }

  /**
   * Get Session By ID
   */
  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.find((s: SessionRecord) => s.id === id)
  }

  /**
   * Get Active Sessions
   */
  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return sessions.filter((s: SessionRecord) => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  /**
   * Add Session
   */
  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    this.store!.set('sessions', [...sessions, session])
  }

  /**
   * Update Session
   */
  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return null
    }
    
    const updated: SessionRecord = {
      ...sessions[index],
      ...updates,
    }

    this.store!.set('sessions', sessions.map((session: SessionRecord, position: number) => position === index ? updated : session))
    return updated
  }

  /**
   * Add Message to Session
   */
  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)
    
    if (index === -1) {
      return null
    }
    
    const config = this.getSessionConfig()
    const current: SessionRecord = sessions[index]
    const retained = current.messages.length >= config.maxMessagesPerSession
      ? current.messages.slice(-config.maxMessagesPerSession + 1)
      : current.messages
    const session: SessionRecord = { ...current, messages: [...retained, message], lastActiveAt: Date.now() }

    this.store!.set('sessions', sessions.map((item: SessionRecord, position: number) => position === index ? session : item))
    return session
  }

  /**
   * Delete Session
   */
  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return false
    }

    this.store!.set('sessions', sessions.filter((session: SessionRecord) => session.id !== id))
    return true
  }

  /**
   * Mark Session as Expired
   */
  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  /**
   * Clean Expired Sessions
   * Always delete sessions with 'expired' status
   * For timed-out active sessions, behavior depends on deleteAfterTimeout config:
   * - If true: Delete them from storage
   * - If false: Mark them as 'expired' (will be deleted on next clean)
   */
  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    let removedCount = 0
    
    // Always delete sessions that are already expired
    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })
    
    // Handle timed-out active sessions based on config
    if (config.deleteAfterTimeout) {
      // Delete timed-out sessions from storage
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      // Mark timed-out sessions as expired (will be deleted on next clean)
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }
    
    this.store!.set('sessions', remainingSessions)
    
    return removedCount
  }

  /**
   * Get Sessions By Account ID
   */
  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.accountId === accountId)
  }

  /**
   * Get Sessions By Provider ID
   */
  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.providerId === providerId)
  }

  /**
   * Clear All Sessions
   */
  clearAllSessions(): void {
    this.ensureInitialized()
    this.store!.set('sessions', [])
  }

  // ==================== Model Management Operations ====================

  /**
   * Get User Model Overrides
   */
  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
  }

  private updateProviderModelOverrides(providerId: string, update: (current: ProviderModelOverrides) => ProviderModelOverrides): void {
    const overrides = this.getUserModelOverrides()
    this.setUserModelOverrides({ ...overrides, [providerId]: update(overrides[providerId] || { addedModels: [], excludedModels: [] }) })
  }

  /**
   * Set User Model Overrides
   */
  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.store!.set('userModelOverrides', overrides)
  }

  /**
   * Get Provider Model Overrides
   */
  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || {
      addedModels: [],
      excludedModels: [],
    }
  }

  /**
   * Get Effective Models for a Provider
   * Merges default models with user overrides
   */
  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    const version = this.storeVersion()
    if (version === undefined) return this.computeEffectiveModels(providerId)
    if (this.effectiveModelsMemo?.version !== version) this.effectiveModelsMemo = { version, models: new Map() }
    const memo = this.effectiveModelsMemo
    const cached = memo.models.get(providerId) ?? this.computeEffectiveModels(providerId)
    if (!memo.models.has(providerId)) this.effectiveModelsMemo = { version, models: new Map([...memo.models, [providerId, cached]]) }
    // Routing reads this per request; the memo stays private and callers get their own copy.
    return structuredClone(cached) as EffectiveModel[]
  }

  private computeEffectiveModels(providerId: string): EffectiveModel[] {
    const provider = (this.peek<Provider[]>('providers') || []).find((p: Provider) => p.id === providerId)
    if (!provider) {
      return []
    }

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)

    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach(displayName => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({
          displayName,
          actualModelId,
          isCustom: false,
          metadata: provider.ollamaModels?.[actualModelId] || provider.ollamaModels?.[displayName],
        })
      }
    })

    overrides.addedModels.forEach(customModel => {
      effectiveModels.push({
        displayName: customModel.displayName,
        actualModelId: customModel.actualModelId,
        isCustom: true,
        metadata: provider.ollamaModels?.[customModel.actualModelId] || provider.ollamaModels?.[customModel.displayName],
      })
    })

    return provider.upstreamKind === 'ollama'
      ? effectiveModels.filter(model => isOllamaModelUsable(provider, model.metadata))
      : effectiveModels
  }

  /**
   * Add Custom Model to Provider
   */
  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    
    const existingModel = this.getProviderModelOverrides(providerId).addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    
    if (existingModel) {
      throw new Error(`Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`)
    }

    this.updateProviderModelOverrides(providerId, current => ({ ...current, addedModels: [...current.addedModels, model] }))

    return this.getEffectiveModels(providerId)
  }

  /**
   * Remove Model from Provider
   * For default models: add to excludedModels
   * For custom models: remove from addedModels
   */
  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error('Provider not found')
    }

    const isDefaultModel = (provider.supportedModels || []).includes(modelName)
    this.updateProviderModelOverrides(providerId, current => isDefaultModel
      ? { ...current, excludedModels: current.excludedModels.includes(modelName) ? current.excludedModels : [...current.excludedModels, modelName] }
      : { ...current, addedModels: current.addedModels.filter(m => m.displayName !== modelName) })

    return this.getEffectiveModels(providerId)
  }

  /**
   * Restore a previously excluded default model.
   */
  restoreModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()

    if (this.getUserModelOverrides()[providerId]) {
      this.updateProviderModelOverrides(providerId, current => ({ ...current, excludedModels: current.excludedModels.filter(excluded => excluded !== modelName) }))
    }

    return this.getEffectiveModels(providerId)
  }

  /**
   * Reset Provider Models to Default
   * Removes all user overrides for the provider
   */
  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (overrides[providerId]) {
      this.setUserModelOverrides(Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== providerId)))
    }

    const builtinConfig = BUILTIN_PROVIDERS.find(provider => provider.id === providerId)
    if (builtinConfig) {
      const providers = (this.store!.get('providers') as Provider[] || []).map(provider => {
        if (provider.id !== providerId || provider.type !== 'builtin') {
          return provider
        }

        return { ...refreshBuiltinProvider(provider, builtinConfig, true), updatedAt: Date.now() }
      })
      this.store!.set('providers', providers)
    }

    return this.getEffectiveModels(providerId)
  }

  // ==================== Utility Methods ====================

  /**
   * Generate Unique ID
   */
  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Get Storage Instance (for internal use only)
   */
  getStore(): StoreType | null {
    return this.store
  }

  /**
   * Clear All Data
   */
  clearAll(): void {
    this.ensureInitialized()
    clearTimeout(this.usageTimer); this.usageTimer = undefined
    this.pendingAccountUsage = new Map()
    this.pendingStatistics = undefined
    this.decryptedValues = new Map()
    this.appLogManager?.clearLogs()
    this.appLogManager?.flushSync()
    this.store!.clear()
    this.store!.set('statistics', { ...DEFAULT_STATISTICS, dailyStatsAvailableFrom: localDateKey() })
    this.resetConfig()
    this.requestLogManager?.clearRequestLogs()
    this.requestLogManager?.flushSync()
  }

  /**
   * Export Data (for backup)
   * Does not include encrypted credential data
   */
  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    this.flushUsage()
    const providers = this.store!.get('providers') || []
    const accounts = (this.store!.get('accounts') || []).map((a: Account) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.store!.get('config') || DEFAULT_CONFIG
    const logs = this.getAppLogManager().exportLogs()
    const requestLogs = this.getRequestLogManager().exportRequestLogs()
    const systemPrompts = this.store!.get('systemPrompts') || []
    const sessions = this.store!.get('sessions') || []
    const statistics = this.store!.get('statistics') || DEFAULT_STATISTICS
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    
    return {
      providers,
      accounts,
      config,
      logs,
      requestLogs,
      systemPrompts,
      sessions,
      statistics,
      userModelOverrides,
    }
  }

  /**
   * Get Storage Path
   */
  getStorePath(): string {
    return this.getStoragePath()
  }

  private getRequestLogManager(): RequestLogManager {
    if (!this.requestLogManager) {
      throw new Error('Request log manager is not initialized')
    }
    return this.requestLogManager
  }

  private getAppLogManager(): AppLogManager {
    if (!this.appLogManager) {
      throw new Error('App log manager is not initialized')
    }
    return this.appLogManager
  }
}

// Export singleton instance
export const storeManager = new StoreManager()

// Export types
export type { StoreType }
