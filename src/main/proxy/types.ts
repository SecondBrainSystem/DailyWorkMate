import type { ModelFeatureInput } from '../../shared/modelFeatures'

/**
 * Proxy Service Module - Type Definitions
 * Defines core data structures for proxy service
 */

/**
 * OpenAI Message Format
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatMessageContent[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatCompletionMessageToolCall[]
  reasoning_content?: string
}

/**
 * Tool Call in Message
 */
export interface ChatCompletionMessageToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Tool Definition for Function Calling (OpenAI compatible)
 */
export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, any>
  }
}

/**
 * Tool Choice Strategy
 */
export type ChatCompletionToolChoice = 'none' | 'auto' | 'required' | {
  type: 'function'
  function: { name: string }
}

/**
 * Message Content (supports multimodal)
 */
export interface ChatMessageContent {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

/**
 * Chat Completions Request
 */
export interface ChatCompletionRequest extends ModelFeatureInput {
  /** Internal transport controls; never serialize these into provider messages. */
  _signal?: AbortSignal
  _timeout?: number
  model: string
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  parallel_tool_calls?: boolean
  stop?: string | string[]
  max_tokens?: number
  max_completion_tokens?: number
  seed?: number
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema'
    json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean }
  }
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>
  user?: string
  /** Enable web search (OpenAI compatible) */
  web_search?: boolean
  /** Web search options (OpenAI compatible) */
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
    user_location?: {
      type: 'approximate'
      approximate?: {
        country?: string
        city?: string
        region?: string
      }
    }
  }
  /** Enable deep research mode (GLM specific) */
  deep_research?: boolean
  /** Tools for function calling */
  tools?: ChatCompletionTool[]
  /** Tool choice strategy */
  tool_choice?: ChatCompletionToolChoice
  /** Tool format - determines response format for tool calls */
  tool_format?: 'native' | 'json' | 'auto'
}

/**
 * Tool Definition for Function Calling
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: {
      type: 'object'
      properties: Record<string, {
        type: string
        description?: string
        enum?: string[]
      }>
      required?: string[]
    }
  }
}

/**
 * Chat Completions Response
 */
export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion' | 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Chat Completions Choice
 */
export interface ChatCompletionChoice {
  index: number
  message?: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  delta?: {
    role?: 'assistant'
    content?: string
    reasoning_content?: string
    tool_calls?: ToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null
}

/**
 * Tool Call in Response
 */
export interface ToolCall {
  index?: number
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Model Information
 */
export interface ModelInfo {
  id: string
  object: 'model'
  created: number
  owned_by: string
  permission?: ModelPermission[]
  root?: string
  parent?: string
}

/**
 * Model Permission
 */
export interface ModelPermission {
  id: string
  object: 'model_permission'
  created: number
  allow_create_engine: boolean
  allow_sampling: boolean
  allow_logprobs: boolean
  allow_search_indices: boolean
  allow_view: boolean
  allow_fine_tuning: boolean
  organization: string
  group: string
  is_blocking: boolean
}

/**
 * Models List Response
 */
export interface ModelsResponse {
  object: 'list'
  data: ModelInfo[]
}

/**
 * Proxy Request Context
 */
export interface ProxyContext {
  requestId: string
  providerId?: string
  accountId?: string
  model: string
  actualModel?: string
  startTime: number
  isStream: boolean
  clientIP?: string
  signal?: AbortSignal
}

/**
 * Request Forward Result
 */
export interface ForwardResult {
  success: boolean
  status?: number
  headers?: Record<string, string>
  body?: any
  stream?: NodeJS.ReadableStream
  skipTransform?: boolean
  error?: string
  errorCode?: string
  latency?: number
  providerSessionId?: string
  parentMessageId?: string
}

/**
 * Account Selection Result
 */
export interface AccountSelection {
  account: import('../store/types').Account
  provider: import('../store/types').Provider
  actualModel: string
}

/**
 * SSE Event
 */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Proxy Statistics
 */
export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

/**
 * Proxy Configuration
 */
export interface ProxyConfig {
  port: number
  host: string
  timeout: number
  retryCount: number
  retryDelay: number
  maxConnections: number
  enableCors: boolean
  corsOrigin: string | string[]
}
