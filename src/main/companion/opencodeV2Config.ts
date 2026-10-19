import path from 'node:path'
import type { WorkspaceGrant } from '../../shared/companion'
import { openCodeFreeModelBaseURL, type OpenCodeFreeModel } from './opencodeModels.ts'
import type { ModelConnection } from '../../shared/modelConnection'

type Rule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
const secretPatterns = ['*.env', '*.env.*', '*credentials*', '*.pem', '*.key', '*/.ssh/*', '*/.aws/*', '*/.gnupg/*']

/** Canonical V2 schema, pinned against the official v2.0.24 source. */
export function buildOpenCodeV2Config(
  grants: WorkspaceGrant[], current: WorkspaceGrant, model: string, baseURL: string,
  _worktree?: string, freeModel?: OpenCodeFreeModel, guardDirectory?: string, allowShell = true, autoApproveCommands = false,
  connection?: ModelConnection,
) {
  if (!model || /[{}#\r\n\0]/.test(model)) throw new Error('Invalid OpenCode model identifier')
  if (!guardDirectory || !path.isAbsolute(guardDirectory) || /[{}\r\n\0]/.test(guardDirectory)) throw new Error('OpenCode V2 requires its managed workspace guard')
  if (!grants.some(grant => grant.id === current.id && grant.path === current.path && grant.writable === current.writable)) throw new Error('Selected workspace is not authorized')
  const providerID = freeModel ? 'opencode' : 'dailyworkmate'
  const modelID = freeModel?.apiModel || connection?.model || model
  if (!modelID || /[{}#\r\n\0]/.test(modelID)) throw new Error('Invalid OpenCode model identifier')
  const selection = { providerID, model: modelID }
  const endpoint = freeModel ? openCodeFreeModelBaseURL(freeModel) : connection?.baseURL || baseURL
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid OpenCode provider URL')
  const patterns = (grant: WorkspaceGrant, relative: boolean) => {
    if (!path.isAbsolute(grant.path) || /[?*{}\[\]\r\n\0]/.test(grant.path)) throw new Error('Invalid OpenCode workspace path')
    const roots = [grant.path.replace(/\\/g, '/').replace(/\/$/, '')]
    if (relative) roots.push(path.relative(current.path, grant.path).replace(/\\/g, '/'))
    return [...new Set(roots.flatMap(root => root ? [root, root + '/*'] : ['.', '*']))]
  }
  const ordered = [...grants].sort((a, b) => a.path.length - b.path.length)
  // A command can touch any folder, so it is approved automatically only when every folder is writable.
  const shell = !current.writable || !allowShell ? 'deny' as const : autoApproveCommands && grants.every(grant => grant.writable) ? 'allow' as const : 'ask' as const
  const permissions: Rule[] = [
    { action: '*', resource: '*', effect: 'deny' },
    ...['glob', 'grep', 'todowrite', 'todoread', 'todo'].map(action => ({ action, resource: '*', effect: 'allow' as const })),
    ...ordered.flatMap(grant => patterns(grant, true).flatMap(resource => [
      { action: 'read', resource, effect: 'allow' as const },
      { action: 'edit', resource, effect: grant.writable ? 'allow' as const : 'deny' as const },
    ])),
    ...ordered.flatMap(grant => patterns(grant, false).map(resource => ({ action: 'external_directory', resource, effect: 'allow' as const }))),
    { action: 'shell', resource: '*', effect: shell },
    ...secretPatterns.flatMap(resource => ['read', 'edit'].map(action => ({ action, resource, effect: 'deny' as const }))),
  ]
  const policyPermissions = permissions.map(rule => ({ action: 'permission', resource: rule.action + ':' + rule.resource, effect: rule.effect === 'deny' ? 'deny' : 'allow' }))
  // '*' in a permission rule is a wildcard action; policies match the combined action:value.
  const policies = [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: providerID, effect: 'allow' },
    { action: 'permission', resource: '*', effect: 'deny' },
    ...policyPermissions.slice(1),
  ]
  const pkg = freeModel?.protocol === 'messages' || connection?.protocol === 'anthropic' ? '@opencode/ai/providers/anthropic'
    : freeModel?.protocol === 'responses' ? '@opencode/ai/providers/openai'
      : '@opencode/ai/providers/openai-compatible'
  const selectedModel = {
    modelID, name: freeModel?.name || modelID, package: pkg,
    capabilities: { tools: freeModel?.toolCall ?? true, input: freeModel?.vision ? ['text', 'image'] : ['text'], output: ['text'] },
    ...(freeModel ? {
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: freeModel.contextLimit, output: freeModel.outputLimit },
      ...(typeof freeModel.interleaved === 'object' ? { compatibility: { reasoningField: freeModel.interleaved.field } } : {}),
    } : {}),
  }
  return {
    $schema: 'https://opencode.ai/config.json', model: selection, default_agent: 'build',
    update: 'disable', share: 'disabled', snapshots: false, warming: false,
    lsp: false, formatter: false, websearch: false, mcp: { servers: {} },
    skills: [], instructions: [], commands: {}, references: {},
    plugins: [{ package: guardDirectory, options: { providerID, modelID } }],
    permissions,
    agents: {
      build: { model: selection, description: 'DailyWorkMate workspace assistant', mode: 'primary', permissions },
      title: { model: selection }, compaction: { model: selection }, summary: { model: selection },
      plan: { disabled: true }, general: { disabled: true }, explore: { disabled: true },
    },
    providers: {
      [providerID]: {
        name: freeModel ? 'OpenCode' : 'DailyWorkMate', package: pkg,
        env: freeModel ? [] : ['DAILYWORKMATE_PROXY_KEY'],
        settings: { baseURL: endpoint, apiKey: freeModel ? 'public' : '{env:DAILYWORKMATE_PROXY_KEY}', transport: 'http' },
        ...(freeModel ? {} : { headers: connection?.direct ? { ...connection.headers } : { 'X-DailyWorkMate-Model-Selection': 'explicit', ...connection?.headers } }),
        models: { [modelID]: selectedModel },
      },
    },
    experimental: { subagent_depth: 0, policies },
  }
}
