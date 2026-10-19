import i18n from 'i18next'
import type { AgentEngine, AgentInput, AgentSnapshot, CompanionAPI, CompanionSnapshot } from '../../../shared/companion'
import type { PersistedChatState } from './chatWorkspace'

export interface ChatWorkspaceSelection {
  workspaceId: string
  groupId: string
  accessScope: 'group' | 'folder'
  relativePath: string
}
export const EMPTY_CHAT_WORKSPACE: ChatWorkspaceSelection = { workspaceId: '', groupId: '', accessScope: 'group', relativePath: '' }

export function workspaceSelectionFromState(state: PersistedChatState): ChatWorkspaceSelection {
  return { workspaceId: state.agentWorkspaceId || '', groupId: state.agentGroupId || '', accessScope: state.agentAccessScope || 'group', relativePath: state.agentRelativePath || '' }
}

/** A saved task can be resumed only with the same engine, model, prompt and actual grants. */
export function chatWorkspaceIdentity(snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'>, selection: ChatWorkspaceSelection, model: string, systemPrompt = '', engine: AgentEngine = 'opencode'): string {
  // OpenCode identities keep their earlier shape so saved sessions still resume.
  const engineField = engine === 'claude' ? { engine } : {}
  if (!selection.workspaceId) return JSON.stringify({ workspaceId: '', model, systemPrompt, grants: [], ...engineField })
  const selected = snapshot.workspaces.find(folder => folder.id === selection.workspaceId)
  if (!selected) throw new Error(i18n.t('workspaceAgent.accessRemoved'))
  const group = selection.groupId ? snapshot.groups.find(group => group.id === selection.groupId) : undefined
  if (selection.groupId && (!group || !group.workspaceIds.includes(selected.id))) throw new Error(i18n.t('workspaceAgent.groupChanged'))
  const grants = snapshot.workspaces.filter(folder => group ? group.workspaceIds.includes(folder.id) : folder.id === selected.id)
    .map(folder => [folder.id, folder.path, folder.writable]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify({ ...selection, model, systemPrompt, grants, ...engineField })
}

export function workspaceStateFields(selection: ChatWorkspaceSelection) {
  return { agentWorkspaceId: selection.workspaceId, agentGroupId: selection.groupId, agentAccessScope: selection.accessScope, agentRelativePath: selection.relativePath }
}

type AgentAPI = Pick<CompanionAPI, 'startAgent' | 'pollAgent' | 'stopAgent' | 'replyPermission'>
export interface WorkspaceAgentOptions { signal?: AbortSignal; onUpdate?: (snapshot: AgentSnapshot) => void }
interface Task {
  controller: AbortController
  ready: Promise<AgentSnapshot>
  /** startAgent has answered; before that a stop request cancels the startup itself. */
  settled: boolean
  sessionId: string
  running: boolean
  stopped?: Promise<void>
}
let owner: WorkspaceAgentRunner | null = null
const cancelled = () => new DOMException('Workspace task cancelled', 'AbortError')
const POLL_INTERVAL = 250
/** Skip renders when a poll brings nothing new (the main process refreshes remote state less often). */
const unchanged = (previous: AgentSnapshot | null, next: AgentSnapshot) => !!previous && previous.sessionId === next.sessionId
  && previous.running === next.running && previous.phase === next.phase && previous.error === next.error && previous.text === next.text
  && JSON.stringify(previous.tools) === JSON.stringify(next.tools) && JSON.stringify(previous.permissions) === JSON.stringify(next.permissions)

/** One owner for the main-process agent prevents route changes from cancelling another page's task. */
export class WorkspaceAgentRunner {
  private task: Task | null = null
  private snapshot: AgentSnapshot | null = null
  private readonly api: AgentAPI
  constructor(api: AgentAPI) { this.api = api }

  async execute(input: AgentInput, options: WorkspaceAgentOptions = {}): Promise<AgentSnapshot> {
    if (this.task || owner) throw new Error(i18n.t('workspaceAgent.busy'))
    if (options.signal?.aborted) throw cancelled()
    owner = this
    const task: Task = { controller: new AbortController(), ready: Promise.resolve(null as unknown as AgentSnapshot), settled: false, sessionId: '', running: false }
    this.task = task
    this.snapshot = null
    const abort = () => { void this.cancel().catch(error => console.error('[Workspace] Could not stop task:', error)) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      task.ready = this.api.startAgent({ ...input, sessionId: input.sessionId || '' })
      task.ready.then(() => { task.settled = true }, () => { task.settled = true })
      let state = await task.ready
      task.sessionId = state.sessionId
      task.running = state.running
      if (!state.sessionId) throw new Error('OpenCode did not return a workspace session')
      if (task.controller.signal.aborted) { await this.stopTask(task); throw cancelled() }
      const publish = (next: AgentSnapshot) => {
        task.running = next.running
        if (unchanged(this.snapshot, next)) return
        this.snapshot = next
        options.onUpdate?.(next)
      }
      publish(state)
      while (state.running) {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); task.controller.signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, POLL_INTERVAL)
          task.controller.signal.addEventListener('abort', finish, { once: true })
        })
        if (task.controller.signal.aborted) { await this.stopTask(task); throw cancelled() }
        state = await this.api.pollAgent()
        if (task.controller.signal.aborted) { await this.stopTask(task); throw cancelled() }
        if (state.sessionId !== task.sessionId) throw new Error(i18n.t('workspaceAgent.sessionChanged'))
        publish(state)
      }
      if (state.error) throw new Error(state.error)
      return state
    } catch (error) {
      // A failed poll must not leave an invisible task editing files in the background.
      if (task.running) await this.stopTask(task)
      if (task.controller.signal.aborted) throw cancelled()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (this.task === task) this.task = null
      if (owner === this) owner = null
    }
  }

  private stopTask(task: Task): Promise<void> {
    if (task.stopped) return task.stopped
    task.stopped = (async () => {
      if (!task.settled && owner === this) {
        // Startup can take tens of seconds; the main process cancels it and its server right away.
        try { await this.api.stopAgent() }
        catch (error) { console.error('[Workspace] Could not cancel the starting task:', error) }
      }
      // If the start won the race anyway, the running task is stopped below.
      const started = await task.ready.catch(() => null)
      if (!started || owner !== this || !started.running) return
      try {
        const current = await this.api.pollAgent()
        if (current.sessionId !== started.sessionId) return
      } catch (error) {
        // The shared owner blocks other chat requests. A broken poll must not prevent
        // interruption of the request that this owner already started successfully.
        console.error('[Workspace] Could not refresh owned session before stopping:', error)
        if (owner !== this || this.task !== task) return
      }
      await this.api.stopAgent()
      task.running = false
    })()
    return task.stopped
  }
  async cancel(): Promise<void> {
    const task = this.task
    if (!task) return
    task.controller.abort()
    await this.stopTask(task)
  }
  async reply(id: string, allow: boolean): Promise<void> {
    if (!this.task || owner !== this || !this.snapshot?.permissions.some(permission => permission.id === id && permission.sessionID === this.task!.sessionId)) {
      throw new Error('This workspace permission request is no longer active')
    }
    await this.api.replyPermission(id, allow)
  }
}
