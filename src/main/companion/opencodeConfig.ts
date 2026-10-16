import type { WorkspaceGrant } from '../../shared/companion'
import path from 'node:path'
import { openCodeFreeModelBaseURL, type OpenCodeFreeModel } from './opencodeModels.ts'

export interface ProxyConnection { proxyHost: string; proxyPort: number; enableApiKey: boolean; apiKeys: Array<{ key: string; enabled: boolean }> }
export function proxyConnection(config: ProxyConnection) {
  const name = ['0.0.0.0', '::', '[::]'].includes(config.proxyHost) ? '127.0.0.1' : config.proxyHost || '127.0.0.1'
  const host = name.includes(':') && !name.startsWith('[') ? '[' + name + ']' : name
  const apiKey = config.enableApiKey ? config.apiKeys.find(key => key.enabled)?.key : 'dailyworkmate-local'
  if (!apiKey) throw new Error('Enable an API key in DailyWorkMate before starting OpenCode')
  return { baseURL: 'http://' + host + ':' + config.proxyPort + '/v1', apiKey }
}

export function buildOpenCodeConfig(grants: WorkspaceGrant[], current: WorkspaceGrant, model: string, baseURL: string, worktree?: string, freeModel?: OpenCodeFreeModel) {
  if (/[{}\r\n]/.test(model)) throw new Error('Invalid model identifier')
  const ordered = [...grants].sort((a, b) => a.path.length - b.path.length)
  const patterns = (grant: WorkspaceGrant, relative: boolean) => {
    const root = grant.path.replace(/\\/g, '/').replace(/\/$/, '')
    if (/[?*{}]/.test(root)) throw new Error('OpenCode workspaces cannot contain wildcard or interpolation characters')
    const roots = relative && worktree ? [root, path.relative(worktree, grant.path)] : [root]
    return [...new Set(roots.flatMap(item => item ? [item, item + path.sep + '*', item.replace(/\\/g, '/'), item.replace(/\\/g, '/') + '/*'] : ['*']))]
  }
  // Keep denials after grants: OpenCode resolves the last matching rule.
  const paths = Object.fromEntries(ordered.flatMap(grant => patterns(grant, true).map(pattern => [pattern, 'allow'])))
  const external = Object.fromEntries(ordered.flatMap(grant => patterns(grant, false).map(pattern => [pattern, 'allow'])))
  const edits = Object.fromEntries(ordered.flatMap(grant => patterns(grant, true).map(pattern => [pattern, grant.writable ? 'allow' : 'deny'])))
  const permission = {
    '*': 'deny',
    read: { '*': 'deny', ...paths, '*.env': 'deny', '*.env.*': 'deny', '*credentials*': 'deny' },
    list: 'allow', glob: 'allow', grep: 'allow',
    edit: { '*': 'deny', ...edits },
    external_directory: { '*': 'deny', ...external },
    bash: current.writable ? 'ask' : 'deny',
    todowrite: 'allow', todoread: 'allow', doom_loop: 'ask',
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    model: freeModel ? 'opencode/' + freeModel.apiModel : 'dailyworkmate/' + model,
    small_model: freeModel ? 'opencode/' + freeModel.apiModel : 'dailyworkmate/' + model,
    enabled_providers: [freeModel ? 'opencode' : 'dailyworkmate'], share: 'disabled', autoupdate: false,
    plugin: [], mcp: {}, lsp: false, formatter: false,
    permission,
    agent: { build: { description: 'DailyWorkMate workspace assistant', mode: 'primary', permission } },
    provider: { ...(freeModel ? { opencode: {
      whitelist: [freeModel.apiModel], options: { apiKey: 'public' },
      models: { [freeModel.apiModel]: {
        id: freeModel.apiModel, name: freeModel.name, tool_call: freeModel.toolCall, reasoning: freeModel.reasoning,
        ...(freeModel.interleaved ? { interleaved: freeModel.interleaved } : {}),
        attachment: freeModel.vision, limit: { context: freeModel.contextLimit, output: freeModel.outputLimit },
        cost: { input: 0, output: 0 }, modalities: { input: freeModel.vision ? ['text', 'image'] : ['text'], output: ['text'] },
        provider: { npm: freeModel.sdk, api: openCodeFreeModelBaseURL(freeModel) },
      } },
    } } : {}), dailyworkmate: {
      npm: '@ai-sdk/openai-compatible', name: 'DailyWorkMate',
      options: { baseURL, apiKey: '{env:DAILYWORKMATE_PROXY_KEY}', headers: { 'X-DailyWorkMate-Model-Selection': 'explicit' } },
      models: { [model]: { name: model, tool_call: true } },
    } },
  }
}
