import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { localDateKey } from '../../shared/localDate.ts'

import type { RequestLogEntry } from '../store/types.ts'
import type {
  RequestLogConfig,
  RequestLogFilter,
  RequestLogStats,
  RequestLogTrendPoint,
} from './types.ts'
import { normalizeRequestLogConfig } from './types.ts'
import {
  sanitizeRequestLogEntry,
  sanitizeRequestLogUpdates,
  trimRequestLogsToMaxEntries,
} from './sanitizer.ts'

interface RequestLogManagerOptions {
  storageDir: string
  config?: Partial<RequestLogConfig>
}

export class RequestLogManager {
  private readonly logFile: string
  private readonly storageDir: string
  private requestLogs: RequestLogEntry[] = []
  private config: RequestLogConfig
  private initialized = false
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false
  private retentionDays = Infinity
  setRetentionDays(days: number): void {
    this.retentionDays = Number.isFinite(days) ? Math.max(1, days) : Infinity
    this.prune()
  }
  private prune(): void {
    if (!Number.isFinite(this.retentionDays)) return
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - this.retentionDays); cutoff.setHours(0, 0, 0, 0)
    const filtered = this.requestLogs.filter(entry => entry.timestamp >= cutoff.getTime())
    if (filtered.length !== this.requestLogs.length) { this.requestLogs = filtered; this.schedulePersist() }
  }
  private readonly persistDelayMs = 2000
  /** Live-view notifications: at most one per log entry per window, carrying its latest state. */
  private readonly notifyDelayMs = 250
  private listeners: ReadonlySet<(entry: RequestLogEntry) => void> = new Set()
  private pendingNotifications: ReadonlyMap<string, RequestLogEntry> = new Map()
  private notifyTimers: ReadonlyMap<string, NodeJS.Timeout> = new Map()

  /** Subscribe to added or updated entries (without bodies). Returns the unsubscribe function. */
  onLogChanged(listener: (entry: RequestLogEntry) => void): () => void {
    this.listeners = new Set([...this.listeners, listener])
    return () => { this.listeners = new Set([...this.listeners].filter(item => item !== listener)) }
  }

  private notifyChanged(entry: RequestLogEntry): void {
    if (!this.listeners.size) return
    const { requestBody: _request, responseBody: _response, errorStack: _stack, ...summary } = entry
    this.pendingNotifications = new Map([...this.pendingNotifications, [entry.id, summary]])
    if (this.notifyTimers.has(entry.id)) return
    const timer = setTimeout(() => {
      const latest = this.pendingNotifications.get(entry.id)
      this.pendingNotifications = new Map([...this.pendingNotifications].filter(([id]) => id !== entry.id))
      this.notifyTimers = new Map([...this.notifyTimers].filter(([id]) => id !== entry.id))
      if (!latest) return
      for (const listener of this.listeners) {
        try { listener(latest) } catch (error) {
          console.error('[RequestLogs] Log change listener failed:', error)
        }
      }
    }, this.notifyDelayMs)
    timer.unref?.()
    this.notifyTimers = new Map([...this.notifyTimers, [entry.id, timer]])
  }

  constructor(options: RequestLogManagerOptions) {
    this.storageDir = options.storageDir
    this.logFile = join(options.storageDir, 'request-logs.ndjson')
    this.config = normalizeRequestLogConfig(options.config)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    mkdirSync(this.storageDir, { recursive: true })
    this.requestLogs = this.loadRequestLogs().map(entry => ({
      ...entry, ...sanitizeRequestLogEntry(entry, { ...this.config, includeBodies: true }),
    }))
    this.prune()
    this.initialized = true
    if (this.requestLogs.length) this.schedulePersist()
  }

  setConfig(config: Partial<RequestLogConfig>): void {
    this.config = normalizeRequestLogConfig(config)
    this.requestLogs = trimRequestLogsToMaxEntries(this.requestLogs, this.config)
    this.schedulePersist()
  }

  async migrateLegacyLogs(legacyLogs: RequestLogEntry[]): Promise<boolean> {
    this.ensureInitialized()

    if (legacyLogs.length === 0 || this.requestLogs.length > 0) {
      return false
    }

    this.requestLogs = trimRequestLogsToMaxEntries(
      [...legacyLogs]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((entry) => ({
          ...sanitizeRequestLogEntry(stripId(entry), this.config),
          id: entry.id,
        })),
      this.config,
    )
    this.schedulePersist()

    return true
  }

  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()

    const logEntry: RequestLogEntry = {
      ...sanitizeRequestLogEntry(entry, this.config),
      id: generateId(),
    }

    if (!this.config.enabled) {
      return logEntry
    }

    this.prune()
    this.requestLogs = [...this.requestLogs, logEntry]
    this.requestLogs = trimRequestLogsToMaxEntries(this.requestLogs, this.config)
    this.schedulePersist()
    this.notifyChanged(logEntry)

    return logEntry
  }

  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    if (!this.config.enabled || this.config.maxEntries <= 0) {
      return false
    }

    const index = this.requestLogs.findIndex((entry) => entry.id === id)
    if (index === -1) {
      return false
    }

    this.requestLogs = this.requestLogs.map((entry, i) => i === index ? { ...entry, ...sanitizeRequestLogUpdates(updates, this.config) } : entry)
    this.schedulePersist()
    this.notifyChanged(this.requestLogs[index])
    return true
  }

  getRequestLogs(limit?: number, filter?: RequestLogFilter): RequestLogEntry[] {
    this.ensureInitialized()
    this.prune()
    let result = [...this.requestLogs]

    if (filter?.status) {
      result = result.filter((entry) => entry.status === filter.status)
    }

    if (filter?.providerId) {
      result = result.filter((entry) => entry.providerId === filter.providerId)
    }

    result.sort((a, b) => b.timestamp - a.timestamp)
    if (filter?.keyword) {
      const query = filter.keyword.toLowerCase().slice(0, 500)
      result = result.filter(entry => [entry.model, entry.actualModel, entry.providerName, entry.accountName, entry.userInput, entry.errorMessage, entry.url].some(value => value?.toLowerCase().includes(query)))
    }
    const offset = Math.max(0, Math.floor(filter?.offset || 0))
    const page = result.slice(offset, limit && limit > 0 ? offset + limit : undefined)
    return filter?.summaryOnly ? page.map(({ requestBody: _request, responseBody: _response, errorStack: _stack, ...entry }) => entry) : page
  }

  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.requestLogs.find((entry) => entry.id === id)
  }

  clearRequestLogs(): void {
    this.ensureInitialized()
    this.requestLogs = []
    this.schedulePersist()
  }

  getRequestLogStats(): RequestLogStats {
    this.ensureInitialized()
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const todayStart = midnight.getTime()
    const tomorrow = new Date(midnight); tomorrow.setDate(tomorrow.getDate() + 1)
    const todayEnd = tomorrow.getTime()
    const todayLogs = this.requestLogs.filter((entry) => entry.timestamp >= todayStart && entry.timestamp < todayEnd)

    return {
      total: this.requestLogs.length,
      success: this.requestLogs.filter((entry) => entry.status === 'success').length,
      error: this.requestLogs.filter((entry) => entry.status === 'error').length,
      todayTotal: todayLogs.length,
      todaySuccess: todayLogs.filter((entry) => entry.status === 'success').length,
      todayError: todayLogs.filter((entry) => entry.status === 'error').length,
    }
  }

  getRequestLogTrend(days: number = 7): RequestLogTrendPoint[] {
    this.ensureInitialized()
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const trends: RequestLogTrendPoint[] = []

    for (let i = days - 1; i >= 0; i--) {
      const start = new Date(today); start.setDate(start.getDate() - i)
      const end = new Date(start); end.setDate(end.getDate() + 1)
      const dayStart = start.getTime(), dayEnd = end.getTime()
      const date = localDateKey(start)
      const dayLogs = this.requestLogs.filter((entry) => entry.timestamp >= dayStart && entry.timestamp < dayEnd)
      const successLogs = dayLogs.filter((entry) => entry.status === 'success')
      const errorLogs = dayLogs.filter((entry) => entry.status === 'error')
      const totalLatency = successLogs.reduce((sum, entry) => sum + entry.latency, 0)

      trends.push({
        date,
        total: dayLogs.length,
        success: successLogs.length,
        error: errorLogs.length,
        avgLatency: successLogs.length > 0 ? Math.round(totalLatency / successLogs.length) : 0,
      })
    }

    return trends
  }

  exportRequestLogs(): RequestLogEntry[] {
    this.ensureInitialized()
    return [...this.requestLogs]
  }

  flushSync(): void {
    if (!this.initialized) {
      return
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }

    this.persistNow()
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RequestLogManager is not initialized')
    }
  }

  private loadRequestLogs(): RequestLogEntry[] {
    if (!existsSync(this.logFile)) {
      return []
    }

    const content = readFileSync(this.logFile, 'utf-8').trim()
    if (!content) {
      return []
    }

    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RequestLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is RequestLogEntry => entry !== null)
  }

  /**
   * Throttle, not debounce: a steady stream of requests less than persistDelayMs apart would
   * otherwise postpone the write forever. The first change starts the timer; later changes join it.
   */
  private schedulePersist(): void {
    this.dirty = true
    if (this.persistTimer) return

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try { this.persistNow() } catch (error) {
        // Entries stay dirty, so the next change or the quit flush retries the write.
        console.error('[RequestLogs] Failed to save request logs:', error)
      }
    }, this.persistDelayMs)
    this.persistTimer.unref?.()
  }

  private persistNow(): void {
    if (!this.dirty) {
      return
    }

    const content = this.requestLogs.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileSync(this.logFile, content, 'utf-8')
    this.dirty = false
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function stripId(entry: RequestLogEntry): Omit<RequestLogEntry, 'id'> {
  const { id: _id, ...rest } = entry
  return rest
}
