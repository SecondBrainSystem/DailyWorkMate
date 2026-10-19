import i18n from 'i18next'
import type { AgentEngine, AgentInput, CompanionSnapshot } from '../../../shared/companion'
import { chatWorkspaceIdentity, type ChatWorkspaceSelection } from './workspaceAgent.ts'

const KNOWN_TOOL_REFUSAL = "I can't make that tool call. I can help with a weather lookup or a read-only database connectivity check."

export interface ToolRecoveryObservation {
  text: string
  error?: string
  aborted: boolean
  running: boolean
  /** Counts include any tool or permission observed earlier in this turn. */
  toolCount: number
  permissionCount: number
}

/** An in-memory description of the original turn, captured before its failed answer. */
export interface ToolRecoveryCandidate {
  conversationId: string
  userId: string
  answerId: string
  sourceModel: string
  prompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  workspace: ChatWorkspaceSelection
  systemPrompt: string
  workspaceAccess: string
  engine?: AgentEngine
}

export interface ToolRecoveryRetryContext {
  model: string
  conversationId: string
  workspace: ChatWorkspaceSelection
  systemPrompt: string
  snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'>
}

/** Only the fully reproduced refusal qualifies; quoted or partial text does not. */
export function isKnownToolRefusal(text: string): boolean {
  return typeof text === 'string' && text.trim().replace(/\s+/g, ' ') === KNOWN_TOOL_REFUSAL
}

export function canOfferToolRecovery(observation: ToolRecoveryObservation): boolean {
  return observation.running === false && observation.aborted === false && !observation.error
    && observation.toolCount === 0 && observation.permissionCount === 0
    && isKnownToolRefusal(observation.text)
}

export function createToolRecoveryCandidate(
  metadata: ToolRecoveryCandidate,
  observation: ToolRecoveryObservation,
): ToolRecoveryCandidate | null {
  if (!canOfferToolRecovery(observation) || !metadata.workspace.workspaceId
    || !metadata.conversationId || !metadata.userId || !metadata.answerId
    || !metadata.sourceModel.trim() || !metadata.prompt.trim() || !metadata.workspaceAccess
    || !metadata.history.every(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')) return null
  return {
    conversationId: metadata.conversationId,
    userId: metadata.userId,
    answerId: metadata.answerId,
    sourceModel: metadata.sourceModel,
    prompt: metadata.prompt,
    history: metadata.history.map(({ role, content }) => ({ role, content })),
    workspace: { ...metadata.workspace },
    systemPrompt: metadata.systemPrompt,
    workspaceAccess: metadata.workspaceAccess,
    ...(metadata.engine === 'claude' ? { engine: metadata.engine } : {}),
  }
}

/** Call with a fresh snapshot immediately before execution. The UI consumes the candidate once. */
export function createToolRecoveryRetryInput(
  candidate: ToolRecoveryCandidate,
  current: ToolRecoveryRetryContext,
): AgentInput {
  const model = current.model.trim()
  if (!model || model === candidate.sourceModel.trim()) {
    throw new Error(i18n.t('toolRecovery.differentModel'))
  }
  const scope = candidate.workspace
  if (!scope.workspaceId || candidate.conversationId !== current.conversationId
    || candidate.systemPrompt !== current.systemPrompt
    || scope.workspaceId !== current.workspace.workspaceId
    || scope.groupId !== current.workspace.groupId
    || scope.accessScope !== current.workspace.accessScope
    || scope.relativePath !== current.workspace.relativePath) {
    throw new Error(i18n.t('toolRecovery.contextChanged'))
  }
  const access = chatWorkspaceIdentity(current.snapshot, current.workspace, candidate.sourceModel, current.systemPrompt, candidate.engine)
  if (access !== candidate.workspaceAccess) {
    throw new Error(i18n.t('toolRecovery.accessChanged'))
  }
  return {
    ...scope,
    model,
    prompt: candidate.prompt,
    systemPrompt: candidate.systemPrompt,
    history: candidate.history.map(({ role, content }) => ({ role, content })),
    sessionId: '',
    newSession: true,
    ...(candidate.engine === 'claude' ? { engine: candidate.engine } : {}),
  }
}
