/**
 * Proxy Service Module - Status Management
 * Records request count, success rate, response time and other statistics
 */

import { ProxyStatistics, ProxyConfig } from './types'

/** Model names come from clients; cap distinct keys so statistics cannot grow without bound. */
const MAX_MODEL_KEYS = 200
const increment = (usage: Record<string, number>, key: string) => ({ ...usage, [key]: (usage[key] || 0) + 1 })

/**
 * Proxy status manager
 */
export class ProxyStatusManager {
  private statistics: ProxyStatistics = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    avgLatency: 0,
    requestsPerMinute: 0,
    activeConnections: 0,
    modelUsage: {},
    providerUsage: {},
    accountUsage: {},
  }

  private config: ProxyConfig = {
    port: 11434,
    host: '0.0.0.0',
    timeout: 120000,
    retryCount: 3,
    retryDelay: 5000,
    maxConnections: 100,
    enableCors: true,
    corsOrigin: '*',
  }

  private startTime: number | null = null
  private isRunning: boolean = false
  private requestTimestamps: number[] = []
  private latencySum: number = 0

  /**
   * Get statistics
   */
  getStatistics(): ProxyStatistics {
    this.cleanupOldTimestamps()
    // Callers receive their own nested maps; the live counters are never shared.
    return {
      ...this.statistics,
      requestsPerMinute: this.requestTimestamps.length,
      avgLatency: this.statistics.totalRequests > 0 ? this.latencySum / this.statistics.totalRequests : 0,
      modelUsage: { ...this.statistics.modelUsage },
      providerUsage: { ...this.statistics.providerUsage },
      accountUsage: { ...this.statistics.accountUsage },
    }
  }

  /**
   * Get configuration
   */
  getConfig(): ProxyConfig {
    return { ...this.config }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get running status
   */
  getRunningStatus(): { isRunning: boolean; startTime: number | null; uptime: number } {
    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    }
  }

  /**
   * Start proxy
   */
  start(): void {
    this.isRunning = true
    this.startTime = Date.now()
  }

  /**
   * Stop proxy
   */
  stop(): void {
    this.isRunning = false
    this.startTime = null
    // Internal chat/CLI requests may still be active after the public API stops.
  }

  /**
   * Record request start
   */
  recordRequestStart(model: string, providerId?: string, accountId?: string): void {
    const { modelUsage } = this.statistics
    const name = String(model).slice(0, 200)
    const modelKey = name in modelUsage || Object.keys(modelUsage).length < MAX_MODEL_KEYS ? name : 'other'
    this.statistics = {
      ...this.statistics,
      totalRequests: this.statistics.totalRequests + 1,
      activeConnections: this.statistics.activeConnections + 1,
      modelUsage: increment(modelUsage, modelKey),
      providerUsage: providerId ? increment(this.statistics.providerUsage, providerId) : this.statistics.providerUsage,
      accountUsage: accountId ? increment(this.statistics.accountUsage, accountId) : this.statistics.accountUsage,
    }
    this.cleanupOldTimestamps()
    this.requestTimestamps = [...this.requestTimestamps, Date.now()]
  }

  /**
   * Record request success
   */
  recordRequestSuccess(latency: number): void {
    this.statistics = { ...this.statistics, successRequests: this.statistics.successRequests + 1, activeConnections: Math.max(0, this.statistics.activeConnections - 1) }
    this.latencySum += latency
  }

  /**
   * Record request failure
   */
  recordRequestFailure(latency: number): void {
    this.statistics = { ...this.statistics, failedRequests: this.statistics.failedRequests + 1, activeConnections: Math.max(0, this.statistics.activeConnections - 1) }
    this.latencySum += latency
  }

  /**
   * Clean up expired timestamps (older than 1 minute)
   */
  private cleanupOldTimestamps(): void {
    const oneMinuteAgo = Date.now() - 60000
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo)
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    this.statistics = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      requestsPerMinute: 0,
      activeConnections: 0,
      modelUsage: {},
      providerUsage: {},
      accountUsage: {},
    }
    this.requestTimestamps = []
    this.latencySum = 0
  }

  /**
   * Get port
   */
  getPort(): number {
    return this.config.port
  }

  /**
   * Set port
   */
  setPort(port: number): void {
    this.config = { ...this.config, port }
  }

  /**
   * Get host
   */
  getHost(): string {
    return this.config.host
  }

  /**
   * Set host
   */
  setHost(host: string): void {
    this.config = { ...this.config, host }
  }
}

export const proxyStatusManager = new ProxyStatusManager()
export default proxyStatusManager
