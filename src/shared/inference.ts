/** Desktop-only inference transport. It never opens a local listening port. */
export interface InternalInferenceRequest {
  id: string
  path: '/v1/models' | '/v1/models/verify' | '/v1/chat/completions'
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
}

export interface InternalInferenceResponse {
  status: number
  headers: Record<string, string>
  body?: unknown
  stream?: boolean
}

export interface InternalInferenceEvent {
  id: string
  data?: string
  done?: boolean
  error?: string
}

export interface InternalInferenceAPI {
  request(input: InternalInferenceRequest): Promise<InternalInferenceResponse>
  onData(callback: (event: InternalInferenceEvent) => void): () => void
  cancel(id: string): Promise<void>
}
