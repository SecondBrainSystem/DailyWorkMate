/** Main-process / terminal-host data only. Never expose credentials to the renderer. */
export interface ModelConnection {
  /** SDK base URL: OpenAI chat appends /chat/completions; Anthropic appends /messages. */
  baseURL: string
  apiKey: string
  model: string
  protocol: 'openai' | 'anthropic'
  headers?: Record<string, string>
  direct: boolean
}

export type ModelConsumer = 'opencode' | 'claude'
