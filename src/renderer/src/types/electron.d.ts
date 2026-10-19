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

/** The bridge type comes from the preload script itself, so the two can never drift apart. */
export type ElectronAPI = import('../../../preload/index').ElectronAPI

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
