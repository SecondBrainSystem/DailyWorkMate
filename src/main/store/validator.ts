/**
 * Credential Storage Module - Credential Validation
 * Validate credentials for each provider
 */

import axios, { AxiosError } from 'axios'
import { Provider, Account, ValidationResult, AuthType } from './types'
import { ProviderChecker } from '../providers/checker'

/**
 * Validator interface
 */
interface Validator {
  validate(credentials: Record<string, string>): Promise<ValidationResult>
}

/**
 * OpenAI API credential validator
 */
class OpenAIValidator implements Validator {
  private apiEndpoint: string

  constructor(apiEndpoint: string) {
    this.apiEndpoint = apiEndpoint
  }

  async validate(credentials: Record<string, string>): Promise<ValidationResult> {
    const apiKey = credentials.apiKey || credentials.token
    
    if (!apiKey) {
      return {
        valid: false,
        error: 'Missing API Key',
        validatedAt: Date.now(),
      }
    }
    
    try {
      const response = await axios.get(`${this.apiEndpoint}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 10000,
      })
      
      if (response.status === 200) {
        return {
          valid: true,
          validatedAt: Date.now(),
          accountInfo: {
            name: 'OpenAI Account',
          },
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: HTTP ${response.status}`,
        validatedAt: Date.now(),
      }
    } catch (error) {
      return this.handleError(error)
    }
  }

  private handleError(error: unknown): ValidationResult {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: { message?: string } }>
      
      if (axiosError.response?.status === 401) {
        return {
          valid: false,
          error: 'Invalid API Key',
          validatedAt: Date.now(),
        }
      }
      
      if (axiosError.response?.status === 429) {
        return {
          valid: false,
          error: 'Rate limit exceeded, please try again later',
          validatedAt: Date.now(),
        }
      }
      
      const message = axiosError.response?.data?.error?.message || axiosError.message
      return {
        valid: false,
        error: `Validation failed: ${message}`,
        validatedAt: Date.now(),
      }
    }
    
    return {
      valid: false,
      error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      validatedAt: Date.now(),
    }
  }
}

/**
 * Claude (Anthropic) API credential validator
 */
class ClaudeValidator implements Validator {
  private apiEndpoint: string

  constructor(apiEndpoint: string) {
    this.apiEndpoint = apiEndpoint
  }

  async validate(credentials: Record<string, string>): Promise<ValidationResult> {
    const apiKey = credentials.apiKey || credentials.token
    
    if (!apiKey) {
      return {
        valid: false,
        error: 'Missing API Key',
        validatedAt: Date.now(),
      }
    }
    
    try {
      const response = await axios.post(
        `${this.apiEndpoint}/messages`,
        {
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      )
      
      if (response.status === 200) {
        return {
          valid: true,
          validatedAt: Date.now(),
          accountInfo: {
            name: 'Anthropic Account',
          },
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: HTTP ${response.status}`,
        validatedAt: Date.now(),
      }
    } catch (error) {
      return this.handleError(error)
    }
  }

  private handleError(error: unknown): ValidationResult {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: { message?: string; type?: string } }>
      
      if (axiosError.response?.status === 401) {
        return {
          valid: false,
          error: 'Invalid API Key',
          validatedAt: Date.now(),
        }
      }
      
      if (axiosError.response?.status === 429) {
        return {
          valid: false,
          error: 'Rate limit exceeded, please try again later',
          validatedAt: Date.now(),
        }
      }
      
      const errorData = axiosError.response?.data?.error
      if (errorData?.type === 'invalid_request_error' && errorData.message?.includes('credit')) {
        return {
          valid: false,
          error: 'Insufficient account balance',
          validatedAt: Date.now(),
        }
      }
      
      const message = errorData?.message || axiosError.message
      return {
        valid: false,
        error: `Validation failed: ${message}`,
        validatedAt: Date.now(),
      }
    }
    
    return {
      valid: false,
      error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      validatedAt: Date.now(),
    }
  }
}

/**
 * ChatGPT Web Cookie validator
 */
class ChatGPTWebValidator implements Validator {
  private apiEndpoint: string

  constructor(apiEndpoint: string) {
    this.apiEndpoint = apiEndpoint
  }

  async validate(credentials: Record<string, string>): Promise<ValidationResult> {
    const cookie = credentials.cookie || credentials.sessionToken
    
    if (!cookie) {
      return {
        valid: false,
        error: 'Missing Cookie or Session Token',
        validatedAt: Date.now(),
      }
    }
    
    try {
      const response = await axios.get(`${this.apiEndpoint}/api/auth/session`, {
        headers: {
          Cookie: cookie,
        },
        timeout: 10000,
      })
      
      if (response.status === 200 && response.data) {
        const data = response.data as { user?: { email?: string; name?: string } }
        
        if (data.user) {
          return {
            valid: true,
            validatedAt: Date.now(),
            accountInfo: {
              email: data.user.email,
              name: data.user.name,
            },
          }
        }
        
        return {
          valid: true,
          validatedAt: Date.now(),
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: HTTP ${response.status}`,
        validatedAt: Date.now(),
      }
    } catch (error) {
      return this.handleError(error)
    }
  }

  private handleError(error: unknown): ValidationResult {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError
      
      if (axiosError.response?.status === 401 || axiosError.response?.status === 403) {
        return {
          valid: false,
          error: 'Invalid or expired Cookie',
          validatedAt: Date.now(),
        }
      }
      
      if (axiosError.response?.status === 429) {
        return {
          valid: false,
          error: 'Rate limit exceeded, please try again later',
          validatedAt: Date.now(),
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: ${axiosError.message}`,
        validatedAt: Date.now(),
      }
    }
    
    return {
      valid: false,
      error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      validatedAt: Date.now(),
    }
  }
}

/**
 * Generic Token Validator
 * Used for simple validation of custom providers
 */
class GenericTokenValidator implements Validator {
  private apiEndpoint: string
  private headers: Record<string, string>
  private authType: AuthType

  constructor(apiEndpoint: string, headers: Record<string, string>, authType: AuthType) {
    this.apiEndpoint = apiEndpoint
    this.headers = headers
    this.authType = authType
  }

  async validate(credentials: Record<string, string>): Promise<ValidationResult> {
    const token = credentials.apiKey || credentials.token || credentials.authorization || credentials.accessToken || credentials.refresh_token || credentials.refreshToken || credentials.ticket || credentials.cookie || credentials.sessionToken
    
    if (!token) {
      return {
        valid: false,
        error: 'Missing authentication token',
        validatedAt: Date.now(),
      }
    }
    
    try {
      const headers: Record<string, string> = {
        ...this.headers,
        ...(this.authType === 'cookie' ? { Cookie: credentials.cookie || credentials.sessionToken || token }
          : this.authType === 'tongyi_sso_ticket' ? { Cookie: 'tongyi_sso_ticket=' + token }
          : { Authorization: /^Bearer\s/i.test(token) ? token : 'Bearer ' + token }),
      }
      
      const response = await axios.get(`${this.apiEndpoint}/models`, {
        headers,
        timeout: 10000,
      })
      
      if (response.status === 200) {
        return {
          valid: true,
          validatedAt: Date.now(),
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: HTTP ${response.status}`,
        validatedAt: Date.now(),
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError
        
        if (axiosError.response?.status === 401) {
          return {
            valid: false,
            error: 'Invalid authentication token',
            validatedAt: Date.now(),
          }
        }
        
        return {
          valid: false,
          error: `Validation failed: ${axiosError.message}`,
          validatedAt: Date.now(),
        }
      }
      
      return {
        valid: false,
        error: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        validatedAt: Date.now(),
      }
    }
  }
}

/**
 * Validate credential validity
 * @param provider Provider configuration
 * @param credentials Credential data
 * @returns Validation result
 */
export async function validateCredentials(
  provider: Provider,
  credentials: Record<string, string>
): Promise<ValidationResult> {
  // Built-in providers use ProviderChecker for validation
  if (provider.upstreamKind === 'ollama') {
    try {
      const { buildOllamaHeaders } = await import('../ollama/transport')
      const { normalizeOllamaUrl } = await import('../ollama/urls')
      const response = await axios.get(normalizeOllamaUrl(provider.apiEndpoint) + '/api/tags', {
        headers: buildOllamaHeaders({ credentials } as Account, provider.headers), timeout: 10000, maxRedirects: 0,
      })
      return { valid: response.status === 200 && Array.isArray(response.data?.models), validatedAt: Date.now() }
    } catch (error) { return { valid: false, error: error instanceof Error ? error.message : 'Node validation failed', validatedAt: Date.now() } }
  }
  if (provider.upstreamKind === 'api') {
    const { checkApiKey } = await import('../providers/apiProviders')
    return { ...(await checkApiKey(provider, credentials.apiKey)), validatedAt: Date.now() }
  }
  if (provider.type === 'builtin') {
    const tempAccount = {
      id: 'temp',
      providerId: provider.id,
      name: 'temp',
      credentials,
      status: 'active' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    const result = await ProviderChecker.checkAccountToken(provider, tempAccount)
    
    return {
      valid: result.valid,
      error: result.error,
      validatedAt: Date.now(),
      accountInfo: result.userInfo,
    }
  }
  
  // Custom providers use generic validator
  const validator = new GenericTokenValidator(provider.apiEndpoint, provider.headers, provider.authType)
  
  try {
    return await validator.validate(credentials)
  } catch (error) {
    return {
      valid: false,
      error: `Validation exception: ${error instanceof Error ? error.message : 'Unknown error'}`,
      validatedAt: Date.now(),
    }
  }
}

/**
 * Batch validate credentials
 * @param providers Provider list
 * @param credentialsMap Credential mapping (provider ID -> credentials)
 * @returns Validation result mapping
 */
export async function validateCredentialsBatch(
  providers: Provider[],
  credentialsMap: Map<string, Record<string, string>>
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>()
  
  const promises = providers.map(async (provider) => {
    const credentials = credentialsMap.get(provider.id)
    
    if (!credentials) {
      results.set(provider.id, {
        valid: false,
        error: 'Missing credentials',
        validatedAt: Date.now(),
      })
      return
    }
    
    const result = await validateCredentials(provider, credentials)
    results.set(provider.id, result)
  })
  
  await Promise.all(promises)
  
  return results
}

/**
 * Quick validate OpenAI API Key
 * @param apiKey API Key
 * @returns Validation result
 */
export async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
  const validator = new OpenAIValidator('https://api.openai.com/v1')
  return validator.validate({ apiKey })
}

/**
 * Quick validate Claude API Key
 * @param apiKey API Key
 * @returns Validation result
 */
export async function validateClaudeKey(apiKey: string): Promise<ValidationResult> {
  const validator = new ClaudeValidator('https://api.anthropic.com/v1')
  return validator.validate({ apiKey })
}

/**
 * Quick validate ChatGPT Cookie
 * @param cookie Cookie string
 * @returns Validation result
 */
export async function validateChatGPTCookie(cookie: string): Promise<ValidationResult> {
  const validator = new ChatGPTWebValidator('https://chat.openai.com')
  return validator.validate({ cookie })
}

export default {
  validateCredentials,
  validateCredentialsBatch,
  validateOpenAIKey,
  validateClaudeKey,
  validateChatGPTCookie,
}
