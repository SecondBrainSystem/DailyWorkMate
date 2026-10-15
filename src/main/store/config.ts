/**
 * Credential Storage Module - App Config Management API
 * Provides read/write operations for app configuration
 */

import { applyAutoStart } from './autoStart'
import { storeManager } from './store'
import { redactSecrets } from '../../shared/redaction'
import { proxyStatusManager } from '../proxy/status'
import {
  AppConfig,
  LoadBalanceStrategy,
  Theme,
  ModelMapping,
  DEFAULT_CONFIG,
} from './types'
import { normalizeToolCallingConfig } from '../../shared/toolCalling'

/**
 * Config Manager class
 * Provides all operations related to app configuration
 */
export class ConfigManager {
  /**
   * Get complete configuration
   */
  static get(): AppConfig {
    return storeManager.getConfig()
  }

  /**
   * Update configuration
   * @param updates Configuration items to update
   * @returns Updated complete configuration
   */
  static update(updates: Partial<AppConfig>): AppConfig {
    const validation = this.validate(updates)
    if (!validation.valid) throw new Error(validation.errors.join('; '))
    
    const updated = storeManager.updateConfig(updates)
    proxyStatusManager.updateConfig({ timeout: updated.requestTimeout, retryCount: updated.retryCount })
    if (updates.autoStart !== undefined) applyAutoStart(updated.autoStart)
    
    storeManager.addLog('info', 'Update app configuration', {
      data: { updates: redactSecrets(updates) },
    })
    
    return updated
  }

  /**
   * Reset configuration to default values
   * @returns Default configuration
   */
  static reset(): AppConfig {
    const config = storeManager.resetConfig()
    proxyStatusManager.updateConfig({ timeout: config.requestTimeout, retryCount: config.retryCount })
    applyAutoStart(config.autoStart)
    
    storeManager.addLog('info', 'Reset app configuration to default values')
    
    return config
  }

  // ==================== Proxy Configuration ====================

  /**
   * Get proxy port
   */
  static getProxyPort(): number {
    const config = this.get()
    return config.proxyPort
  }

  /**
   * Set proxy port
   * @param port Port number
   */
  static setProxyPort(port: number): void {
    if (port < 1 || port > 65535) {
      throw new Error('Port number must be between 1-65535')
    }
    
    this.update({ proxyPort: port })
  }

  /**
   * Get load balance strategy
   */
  static getLoadBalanceStrategy(): LoadBalanceStrategy {
    const config = this.get()
    return config.loadBalanceStrategy
  }

  /**
   * Set load balance strategy
   * @param strategy Strategy type
   */
  static setLoadBalanceStrategy(strategy: LoadBalanceStrategy): void {
    this.update({ loadBalanceStrategy: strategy })
  }

  // ==================== Model Mapping Configuration ====================

  /**
   * Get all model mappings
   */
  static getModelMappings(): Record<string, ModelMapping> {
    const config = this.get()
    return config.modelMappings
  }

  /**
   * Get mapping config for specified model
   * @param model Model name
   */
  static getModelMapping(model: string): ModelMapping | undefined {
    const mappings = this.getModelMappings()
    return mappings[model]
  }

  /**
   * Add or update model mapping
   * @param mapping Mapping config
   */
  static setModelMapping(mapping: ModelMapping): void {
    const config = this.get()
    const mappings = { ...config.modelMappings }
    mappings[mapping.requestModel] = mapping
    
    this.update({ modelMappings: mappings })
    
    storeManager.addLog('info', `Set model mapping: ${mapping.requestModel} -> ${mapping.actualModel}`)
  }

  /**
   * Delete model mapping
   * @param model Model name
   */
  static removeModelMapping(model: string): boolean {
    const config = this.get()
    const mappings = { ...config.modelMappings }
    
    if (!(model in mappings)) {
      return false
    }
    
    delete mappings[model]
    this.update({ modelMappings: mappings })
    
    storeManager.addLog('info', `Delete model mapping: ${model}`)
    
    return true
  }

  /**
   * Batch set model mappings
   * @param mappings Mapping config list
   */
  static setModelMappings(mappings: ModelMapping[]): void {
    const mappingRecord: Record<string, ModelMapping> = {}
    
    for (const mapping of mappings) {
      mappingRecord[mapping.requestModel] = mapping
    }
    
    this.update({ modelMappings: mappingRecord })
    
    storeManager.addLog('info', `Batch set model mappings: ${mappings.length} items`)
  }

  /**
   * Resolve actual model to use
   * @param requestedModel Requested model name
   * @returns Actual model name to use
   */
  static resolveActualModel(requestedModel: string): string {
    const mapping = this.getModelMapping(requestedModel)
    return mapping?.actualModel || requestedModel
  }

  // ==================== UI Configuration ====================

  /**
   * Get theme setting
   */
  static getTheme(): Theme {
    const config = this.get()
    return config.theme
  }

  /**
   * Set theme
   * @param theme Theme type
   */
  static setTheme(theme: Theme): void {
    this.update({ theme })
  }

  /**
   * Get auto-start on boot setting
   */
  static getAutoStart(): boolean {
    const config = this.get()
    return config.autoStart
  }

  /**
   * Set auto-start on boot
   * @param autoStart Whether to auto-start on boot
   */
  static setAutoStart(autoStart: boolean): void {
    this.update({ autoStart })
  }

  /**
   * Get minimize to tray setting
   */
  static getMinimizeToTray(): boolean {
    const config = this.get()
    return config.minimizeToTray
  }

  /**
   * Set minimize to tray
   * @param minimizeToTray Whether to minimize to tray
   */
  static setMinimizeToTray(minimizeToTray: boolean): void {
    this.update({ minimizeToTray })
  }

  // ==================== Log Configuration ====================

  /**
   * Get log level
   */
  static getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
    const config = this.get()
    return config.logLevel
  }

  /**
   * Set log level
   * @param level Log level
   */
  static setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.update({ logLevel: level })
  }

  /**
   * Get log retention days
   */
  static getLogRetentionDays(): number {
    const config = this.get()
    return config.logRetentionDays
  }

  /**
   * Set log retention days
   * @param days Number of days
   */
  static setLogRetentionDays(days: number): void {
    if (days < 1 || days > 365) {
      throw new Error('Log retention days must be between 1-365')
    }
    
    this.update({ logRetentionDays: days })
  }

  // ==================== Request Configuration ====================

  /**
   * Get request timeout
   */
  static getRequestTimeout(): number {
    const config = this.get()
    return config.requestTimeout
  }

  /**
   * Set request timeout
   * @param timeout Timeout in milliseconds
   */
  static setRequestTimeout(timeout: number): void {
    if (timeout < 1000 || timeout > 300000) {
      throw new Error('Request timeout must be between 1000-300000 milliseconds')
    }
    
    this.update({ requestTimeout: timeout })
  }

  /**
   * Get retry count
   */
  static getRetryCount(): number {
    const config = this.get()
    return config.retryCount
  }

  /**
   * Set retry count
   * @param count Retry count
   */
  static setRetryCount(count: number): void {
    if (count < 0 || count > 10) {
      throw new Error('Retry count must be between 0-10')
    }
    
    this.update({ retryCount: count })
  }

  // ==================== Utility Methods ====================

  /**
   * Validate if configuration is valid
   * @param config Configuration to validate
   * @returns Validation result
   */
  static validate(config: Partial<AppConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { valid: false, errors: ['Configuration must be an object'] }
    for (const field of ['proxyPort', 'logRetentionDays', 'requestTimeout', 'retryCount'] as const) {
      if (config[field] !== undefined && !Number.isInteger(config[field])) errors.push(field + ' must be an integer')
    }
    for (const field of ['autoStart', 'minimizeToTray', 'autoStartProxy', 'enableApiKey'] as const) {
      if (config[field] !== undefined && typeof config[field] !== 'boolean') errors.push(field + ' must be a boolean')
    }
    if (config.proxyHost !== undefined && (typeof config.proxyHost !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(config.proxyHost))) errors.push('Invalid proxy host')
    if (config.theme !== undefined && !['light','dark','system'].includes(config.theme)) errors.push('Invalid theme')
    if (config.language !== undefined && !['zh-CN','en-US'].includes(config.language)) errors.push('Invalid language')
    if (config.loadBalanceStrategy !== undefined && !['round-robin','fill-first','failover'].includes(config.loadBalanceStrategy)) errors.push('Invalid load balance strategy')
    if (config.apiKeys !== undefined && (!Array.isArray(config.apiKeys) || config.apiKeys.some(key => !key || typeof key.key !== 'string' || typeof key.id !== 'string' || typeof key.enabled !== 'boolean'))) errors.push('Invalid API keys')
    if (config.modelMappings !== undefined && (!config.modelMappings || typeof config.modelMappings !== 'object' || Array.isArray(config.modelMappings) || Object.values(config.modelMappings).some(mapping => !mapping || typeof mapping.actualModel !== 'string' || !mapping.actualModel.trim()))) errors.push('Invalid model mappings')
    if (config.managementApi?.enableManagementApi && !config.managementApi.managementApiSecret && !this.get().managementApi.managementApiSecret) errors.push('Set a management API secret before enabling it')
    
    if (config.proxyPort !== undefined) {
      if (config.proxyPort < 1 || config.proxyPort > 65535) {
        errors.push('Proxy port must be between 1-65535')
      }
    }
    
    if (config.logRetentionDays !== undefined) {
      if (config.logRetentionDays < 1 || config.logRetentionDays > 365) {
        errors.push('Log retention days must be between 1-365')
      }
    }
    
    if (config.requestTimeout !== undefined) {
      if (config.requestTimeout < 1000 || config.requestTimeout > 300000) {
        errors.push('Request timeout must be between 1000-300000 milliseconds')
      }
    }
    
    if (config.retryCount !== undefined) {
      if (config.retryCount < 0 || config.retryCount > 10) {
        errors.push('Retry count must be between 0-10')
      }
    }

    if (config.toolCallingConfig) {
      const normalized = normalizeToolCallingConfig(config.toolCallingConfig)
      if (
        config.toolCallingConfig.mode !== undefined &&
        normalized.mode !== config.toolCallingConfig.mode
      ) {
        errors.push('toolCallingConfig.mode must be one of: off, auto, force')
      }
      if (
        config.toolCallingConfig.clientAdapterId !== undefined &&
        !['standard-openai-tools', 'cherry-studio-mcp'].includes(String(config.toolCallingConfig.clientAdapterId))
      ) {
        errors.push('toolCallingConfig.clientAdapterId must be one of: standard-openai-tools, cherry-studio-mcp')
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Get configuration diff
   * @param newConfig New configuration
   * @returns Diff from default configuration
   */
  static getDiff(newConfig: Partial<AppConfig>): Partial<AppConfig> {
    const diff: Partial<AppConfig> = {}
    const current = this.get()
    
    for (const key of Object.keys(newConfig) as (keyof AppConfig)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(newConfig[key])) {
        (diff as Record<string, unknown>)[key] = newConfig[key]
      }
    }
    
    return diff
  }

  /**
   * Export configuration (for backup)
   */
  static export(): AppConfig {
    return { ...this.get(), apiKeys: [], managementApi: { ...this.get().managementApi, managementApiSecret: '' }, internalProxyKey: undefined }
  }

  /**
   * Import configuration (for restore)
   * @param config Configuration data
   */
  static import(config: Partial<AppConfig>): { success: boolean; errors: string[] } {
    const validation = this.validate(config)
    
    if (!validation.valid) {
      return { success: false, errors: validation.errors }
    }
    
    this.update(config)
    
    storeManager.addLog('info', 'Import app configuration')
    
    return { success: true, errors: [] }
  }
}

export default ConfigManager
