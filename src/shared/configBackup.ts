import type { AppConfig } from './types'
const keys = ['language', 'theme', 'uiTypography', 'proxyPort', 'proxyHost', 'additionalProxyListeners', 'loadBalanceStrategy', 'modelMappings', 'ollamaRouting', 'modelFeatureDefaults', 'autoStart', 'autoStartProxy', 'minimizeToTray', 'logLevel', 'logRetentionDays', 'requestLogConfig', 'requestTimeout', 'retryCount', 'oauthProxyMode', 'sessionConfig', 'contextManagement', 'toolCallingConfig'] as const
export function configurationBackup(value: AppConfig): Partial<AppConfig> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
export function readConfigurationBackup(value: unknown): Partial<AppConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration file')
  const envelope = value as Record<string, unknown>
  let config = envelope.config
  if (!config && typeof envelope.settings === 'string') {
    const legacy = JSON.parse(envelope.settings)
    config = legacy?.state?.config
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('No application configuration in this file')
  return configurationBackup(config as AppConfig)
}
