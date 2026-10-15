import axios from 'axios'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { AgentPermission } from '../../shared/companion'

/** OpenCode 2.0.24 public HTTP protocol (packages/protocol/openapi.json). */
export interface OpenCodeV2Model { providerID: string; modelID: string }
export interface OpenCodeV2Message {
  info: { id: string; role: string; error?: { name?: string; data?: { message?: string } } }
  parts: Array<{ id: string; type: string; text?: string; tool?: string; state?: { status?: string; title?: string; input?: unknown; error?: string } }>
}
export interface OpenCodeV2Session { id: string; directory: string; outcome?: string }
export type OpenCodeV2LiveEvent =
  | { type: 'text'; messageId: string; ordinal: number; text: string; operation: 'start' | 'delta' | 'end' }
  | { type: 'phase'; phase: 'thinking' | 'responding' | 'tool' }
export interface OpenCodeV2EventSubscription { close: () => void }
interface RecordValue { [key: string]: unknown }

function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OpenCode V2 ' + label)
  return value as RecordValue
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid OpenCode V2 ' + label)
  return value
}
function idPath(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid OpenCode V2 identifier')
  return encodeURIComponent(value)
}
function structuredError(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as RecordValue).message === 'string') return (value as RecordValue).message as string
  return 'OpenCode V2 returned an unspecified error'
}
function sessionInfo(value: unknown): OpenCodeV2Session {
  const info = object(object(value, 'session response').data, 'session')
  const location = object(info.location, 'session location')
  return { id: string(info.id, 'session ID'), directory: string(location.directory, 'session directory'),
    ...(typeof info.outcome === 'string' ? { outcome: info.outcome } : {}) }
}

/** Convert V2 projected messages without dropping text, tool results or structured errors. */
export function normalizeOpenCodeV2Message(value: unknown): OpenCodeV2Message {
  const message = object(value, 'message')
  const id = string(message.id, 'message ID')
  const type = string(message.type, 'message type')
  if (type !== 'assistant') {
    return { info: { id, role: type === 'user' ? 'user' : 'system' }, parts: typeof message.text === 'string'
      ? [{ id: id + ':text', type: 'text', text: message.text }] : [] }
  }
  if (!Array.isArray(message.content)) throw new Error('Invalid OpenCode V2 assistant content')
  const error = message.error ? structuredError(message.error)
    : message.finish === 'length' ? 'OpenCode model reached its output limit; the partial answer was preserved.' : undefined
  return {
    info: { id, role: 'assistant', ...(error ? { error: { name: 'OpenCodeV2Error', data: { message: error } } } : {}) },
    parts: message.content.map((value, index) => {
      const part = object(value, 'content part')
      const partType = string(part.type, 'content type')
      if (partType === 'text' || partType === 'reasoning') {
        if (typeof part.text !== 'string') throw new Error('Invalid OpenCode V2 content text')
        return { id: `${id}:${index}`, type: partType, text: part.text }
      }
      if (partType !== 'tool') throw new Error('Unsupported OpenCode V2 content type: ' + partType)
      const state = object(part.state, 'tool state')
      const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata as RecordValue : undefined
      return {
        id: string(part.id, 'tool ID'), type: 'tool', tool: string(part.name, 'tool name'),
        state: { status: string(state.status, 'tool status'), input: state.input,
          ...(typeof metadata?.title === 'string' ? { title: metadata.title } : {}),
          ...(state.error ? { error: structuredError(state.error) } : {}),
        },
      }
    }),
  }
}

export class OpenCodeV2Client {
  private readonly address: string
  private readonly password: string
  private readonly directory: string

  constructor(address: string, password: string, directory: string) {
    const url = new URL(address)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('OpenCode V2 must use a local HTTP server')
    }
    this.address = url.origin
    this.password = string(password, 'server password')
    this.directory = string(directory, 'workspace directory')
  }

  private async request(method: string, endpoint: string, data?: unknown, signal?: AbortSignal, timeout = 12000): Promise<unknown> {
    try {
      const response = await axios.request({ method, url: this.address + endpoint, data, signal, timeout,
        proxy: false, maxRedirects: 0, maxContentLength: 32 * 1024 * 1024,
        auth: { username: 'opencode', password: this.password }, headers: { Accept: 'application/json' },
      })
      return response.data
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error
      if (signal?.aborted || axios.isCancel(error)) throw new Error('OpenCode V2 request cancelled')
      const detail = error.response?.data
      const explanation = typeof detail === 'string' ? detail.slice(0, 2000)
        : detail && typeof detail === 'object' ? structuredError(detail).slice(0, 2000) : error.message
      throw new Error(`OpenCode V2 ${method} ${endpoint.split('?')[0]} failed${error.response ? ` (HTTP ${error.response.status})` : ''}: ${explanation}`)
    }
  }

  private locationQuery(): string { return '?location%5Bdirectory%5D=' + encodeURIComponent(this.directory) }

  async health(): Promise<{ healthy: true; version: string }> {
    const info = object(await this.request('GET', '/api/info'), 'server info')
    const version = string(info.version, 'server version')
    if (!/^2\./.test(version)) throw new Error('OpenCode V2 is required; the server reported ' + version)
    return { healthy: true, version }
  }

  async location(): Promise<{ worktree: string; directory: string }> {
    const location = object(await this.request('GET', '/api/location' + this.locationQuery(), undefined, undefined, 120000), 'location')
    const project = object(location.project, 'project')
    const directory = string(location.directory, 'directory')
    if (path.relative(this.directory, directory) !== '') throw new Error('OpenCode V2 resolved a different workspace')
    return { directory, worktree: string(project.directory, 'project directory') }
  }

  async assertGuard(expectedId = 'dailyworkmate-workspace-guard-v2', expectedPath?: string): Promise<void> {
    // A cold V2 location activates plugins asynchronously; the inventory initially is empty.
    // Wait for the actual guard to become active, never infer readiness from server startup.
    const deadline = Date.now() + 45000
    while (true) {
      const response = object(await this.request('GET', '/api/plugin' + this.locationQuery()), 'plugin response')
      const directory = string(object(response.location, 'plugin location').directory, 'plugin directory')
      if (path.relative(this.directory, directory) !== '' || !Array.isArray(response.data)) throw new Error('OpenCode V2 workspace guard location mismatch')
      const guard = response.data.map(value => object(value, 'plugin')).find(plugin => plugin.id === expectedId)
      if (guard) {
        if (object(guard.state, 'plugin state').status !== 'active' || object(guard.features, 'plugin features').server !== true) {
          const reason = object(guard.state, 'plugin state').error
          throw new Error('OpenCode V2 workspace guard is not active' + (typeof reason === 'string' ? ': ' + reason : ''))
        }
        if (expectedPath) {
          const source = object(guard.source, 'plugin source')
          if (source.type !== 'local' || path.relative(expectedPath, string(source.path, 'plugin path')) !== '') {
            throw new Error('OpenCode V2 workspace guard source mismatch')
          }
        }
        return
      }
      if (Date.now() >= deadline) throw new Error('OpenCode V2 workspace guard did not become active')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  async createSession(title: string, model: OpenCodeV2Model, agent = 'build'): Promise<OpenCodeV2Session> {
    return sessionInfo(await this.request('POST', '/api/session', {
      title, agent, model: { providerID: model.providerID, id: model.modelID }, location: { directory: this.directory },
    }))
  }

  async getSession(id: string): Promise<OpenCodeV2Session> { return sessionInfo(await this.request('GET', '/api/session/' + idPath(id))) }

  async messages(id: string): Promise<OpenCodeV2Message[]> {
    let messages: OpenCodeV2Message[] = []
    let cursor: string | undefined
    const visited = new Set<string>()
    do {
      const query = cursor ? '&cursor=' + encodeURIComponent(cursor) : '&order=asc'
      const page = object(await this.request('GET', '/api/session/' + idPath(id) + '/message?limit=200' + query), 'messages response')
      if (!Array.isArray(page.data)) throw new Error('Invalid OpenCode V2 messages')
      messages = [...messages, ...page.data.map(normalizeOpenCodeV2Message)]
      const next = object(page.cursor, 'message cursor').next
      cursor = typeof next === 'string' && next ? next : undefined
      if (cursor && visited.has(cursor)) throw new Error('OpenCode V2 message pagination repeated a cursor')
      if (cursor) visited.add(cursor)
    } while (cursor)
    return messages
  }

  async addHistory(id: string, text: string): Promise<void> {
    await this.request('POST', '/api/session/' + idPath(id) + '/synthetic', { text, description: 'Conversation history imported by DailyWorkMate', resume: false })
  }

  /** V2 message projections omit text deltas until a block ends. Subscribe before prompting.
   * Events are volatile, so callers still reconcile the final answer against messages(). */
  async subscribeSession(id: string, onEvent: (event: OpenCodeV2LiveEvent) => void, onError: (error: Error) => void,
    signal?: AbortSignal): Promise<OpenCodeV2EventSubscription> {
    idPath(id)
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, 12000)
    let source: Readable
    try {
      const response = await axios.request<Readable>({ method: 'GET', url: this.address + '/api/event', responseType: 'stream',
        signal: controller.signal, timeout: 0, proxy: false, maxRedirects: 0,
        auth: { username: 'opencode', password: this.password }, headers: { Accept: 'text/event-stream' } })
      if (!String(response.headers['content-type'] || '').includes('text/event-stream')) {
        response.data.destroy()
        throw new Error('OpenCode V2 event endpoint did not return an event stream')
      }
      source = response.data
    } catch (error) {
      signal?.removeEventListener('abort', abort)
      if (axios.isAxiosError(error) && error.response?.data && typeof error.response.data.destroy === 'function') error.response.data.destroy()
      if (signal?.aborted) throw new Error('OpenCode V2 event subscription cancelled')
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      throw new Error('OpenCode V2 event subscription failed' + (status ? ` (HTTP ${status})` : ''))
    } finally { clearTimeout(timer) }
    let closed = false
    let buffer = ''
    let seen = new Set<string>()
    const close = () => {
      if (closed) return
      closed = true
      signal?.removeEventListener('abort', abort)
      source.destroy()
      controller.abort()
    }
    const fail = (error: Error) => {
      if (closed || signal?.aborted) { close(); return }
      close()
      onError(error)
    }
    const accept = (frame: string) => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) return
      const event = object(JSON.parse(data), 'event')
      if (typeof event.type !== 'string' || !event.type.startsWith('session.')) return
      const payload = object(event.data, 'event data')
      if (payload.sessionID !== id) return
      if (event.location) {
        const directory = string(object(event.location, 'event location').directory, 'event directory')
        if (path.relative(this.directory, directory) !== '') return
      }
      const eventId = string(event.id, 'event ID')
      if (seen.has(eventId)) return
      seen = new Set([...seen, eventId].slice(-1024))
      if (['session.text.started', 'session.text.delta', 'session.text.ended'].includes(event.type)) {
        const messageId = string(payload.assistantMessageID, 'event message ID')
        idPath(messageId)
        const ordinal = payload.ordinal
        if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0 || (ordinal as number) > 10000) throw new Error('Invalid OpenCode V2 text ordinal')
        const operation = event.type === 'session.text.started' ? 'start' : event.type === 'session.text.delta' ? 'delta' : 'end'
        const text = operation === 'start' ? '' : operation === 'delta' ? payload.delta : payload.text
        if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Invalid OpenCode V2 text event')
        onEvent({ type: 'text', messageId, ordinal: ordinal as number, text, operation })
      } else if (event.type.startsWith('session.reasoning.')) {
        // Expose the activity without retaining or forwarding private reasoning text.
        onEvent({ type: 'phase', phase: 'thinking' })
      } else if (event.type.startsWith('session.tool.')) {
        onEvent({ type: 'phase', phase: 'tool' })
      }
    }
    source.setEncoding('utf8')
    source.on('data', (chunk: string) => {
      if (closed) return
      try {
        buffer += chunk
        if (buffer.length > 4 * 1024 * 1024) throw new Error('OpenCode V2 event frame exceeds the size limit')
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          accept(frame)
        }
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid OpenCode V2 event stream')) }
    })
    source.on('error', () => fail(new Error('OpenCode V2 event stream disconnected')))
    source.on('end', () => fail(new Error('OpenCode V2 event stream ended')))
    source.on('close', () => fail(new Error('OpenCode V2 event stream closed')))
    if (signal?.aborted) close()
    return { close }
  }

  async prompt(id: string, input: { model: OpenCodeV2Model; agent?: string; system: string; text: string }, signal?: AbortSignal): Promise<void> {
    const session = '/api/session/' + idPath(id)
    await this.request('POST', session + '/model', { model: { providerID: input.model.providerID, id: input.model.modelID } }, signal)
    await this.request('POST', session + '/agent', { agent: input.agent || 'build' }, signal)
    await this.request('PUT', '/api/experimental/session/' + idPath(id) + '/instructions/entries/dailyworkmate-workspace', { value: input.system }, signal)
    await this.request('POST', session + '/prompt', { text: input.text }, signal)
    await this.request('POST', '/api/experimental/session/' + idPath(id) + '/wait', undefined, signal, 15 * 60 * 1000)
  }

  async setInstructions(id: string, value: string): Promise<void> {
    await this.request('PUT', '/api/experimental/session/' + idPath(id) + '/instructions/entries/dailyworkmate-workspace', { value })
  }

  async selectModel(id: string, model: OpenCodeV2Model): Promise<void> {
    await this.request('POST', '/api/session/' + idPath(id) + '/model', { model: { providerID: model.providerID, id: model.modelID } })
    await this.request('POST', '/api/session/' + idPath(id) + '/agent', { agent: 'build' })
  }

  async permissions(id: string): Promise<AgentPermission[]> {
    const response = object(await this.request('GET', '/api/session/' + idPath(id) + '/permission'), 'permission response')
    if (!Array.isArray(response.data)) throw new Error('Invalid OpenCode V2 permission list')
    return response.data.map(value => {
      const permission = object(value, 'permission')
      const sessionID = string(permission.sessionID, 'permission session')
      if (sessionID !== id || !Array.isArray(permission.resources) || permission.resources.some(value => typeof value !== 'string')) {
        throw new Error('OpenCode V2 permission does not belong to this session')
      }
      return { id: string(permission.id, 'permission ID'), sessionID, permission: string(permission.action, 'permission action'), patterns: [...permission.resources] as string[] }
    })
  }

  async reply(id: string, requestId: string, allow: boolean): Promise<void> {
    if (typeof allow !== 'boolean') throw new Error('Invalid OpenCode V2 permission decision')
    await this.request('POST', '/api/session/' + idPath(id) + '/permission/' + idPath(requestId) + '/reply', { decision: allow ? 'once' : 'reject' })
  }

  async abort(id: string): Promise<void> { await this.request('POST', '/api/session/' + idPath(id) + '/interrupt?resume=false') }
}
