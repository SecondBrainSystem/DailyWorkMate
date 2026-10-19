import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildOpenCodeV2Config } from '../../src/main/companion/opencodeV2Config.ts'
import { installWorkspaceGuardV2, workspaceGuardV2Source } from '../../src/main/companion/workspaceGuardV2.ts'
import type { WorkspaceGrant } from '../../src/shared/companion.ts'
import type { OpenCodeFreeModel } from '../../src/main/companion/opencodeModels.ts'

async function fixture(writable = false, options: { allowShell?: boolean; readonlyChild?: boolean } = {}) {
  await mkdir(path.resolve('tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(path.join(path.resolve('tmp'), 'v2-guard-')))
  const directory = path.join(root, 'workspace')
  await mkdir(directory)
  const grant: WorkspaceGrant = { id: 'qa', name: 'QA', path: directory, writable }
  const readonlyDirectory = path.join(directory, 'readonly')
  const grants = options.readonlyChild ? [grant, { id: 'readonly', name: 'Read only', path: readonlyDirectory, writable: false }] : [grant]
  if (options.readonlyChild) await mkdir(readonlyDirectory)
  await writeFile(path.join(directory, 'note.txt'), 'synthetic note')
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const removed: string[] = []
  const tools: Record<string, any> = {}
  const plugin = (await import('data:text/javascript;base64,' + Buffer.from(workspaceGuardV2Source(grants, directory, options.allowShell ?? true)).toString('base64'))).default
  await plugin.setup({ location: { directory }, options: { providerID: 'dailyworkmate', modelID: 'qa-model' },
    model: { transform: async (fn: any) => fn({ list: () => [{ providerID: 'dailyworkmate', id: 'qa-model' }, { providerID: 'dailyworkmate', id: 'paid' }, { providerID: 'other', id: 'paid' }], remove: (provider: string, model: string) => removed.push(provider + '/' + model) }) },
    session: { hook: async (name: string, fn: any) => { hooks[name] = fn } },
    tool: { transform: async (fn: any) => fn({ update: (name: string, update: any) => { const tool = {}; update(tool); tools[name] = tool } }), hook: async (name: string, fn: any) => { hooks[name] = fn } },
  })
  const invoke = async (tool: string, input: object) => { const event = { tool, input }; await hooks['execute.before'](event); return event.input }
  const search = async (name: string, input: object) => tools[name].execute(await invoke(name, input))
  return { root, directory, grant, grants, readonlyDirectory, hooks, removed, invoke, search }
}

test('V2 readonly config restricts providers and hard-denies shell/edit despite saved approvals', async () => {
  const { root, grant } = await fixture()
  const config = buildOpenCodeV2Config([grant], grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, path.join(root, 'guard'))
  const permission = (action: string, resource: string) => config.permissions.findLast(rule => rule.action === action && rule.resource === resource)?.effect
  assert.equal(permission('shell', '*'), 'deny')
  assert.equal(permission('edit', '*'), 'deny')
  assert.deepEqual(config.experimental.policies.slice(0, 2), [
    { action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'dailyworkmate', effect: 'allow' },
  ])
  assert.equal(config.experimental.policies.findLast(rule => rule.resource === 'shell:*')?.effect, 'deny')
  assert.equal(config.providers.dailyworkmate.settings.apiKey, '{env:DAILYWORKMATE_PROXY_KEY}')
  assert.equal(config.snapshots, false)
  assert.deepEqual(config.plugins[0].options, { providerID: 'dailyworkmate', modelID: 'qa-model' })
  assert.throws(() => buildOpenCodeV2Config([grant], grant, 'qa-model', 'http://localhost/v1'), /guard/)
})

test('V2 writable command permissions are automatic only when explicitly configured for chat', async () => {
  const { root, grant } = await fixture(true)
  const guardDirectory = path.join(root, 'guard')
  const native = buildOpenCodeV2Config([grant], grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, guardDirectory)
  const chat = buildOpenCodeV2Config([grant], grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, guardDirectory, true, true)
  for (const [config, expected] of [[native, 'ask'], [chat, 'allow']] as const) {
    assert.equal(config.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, expected)
    assert.equal(config.agents.build.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, expected)
    assert.equal(config.experimental.policies.findLast(rule => rule.resource === 'shell:*')?.effect, 'allow')
  }
})

test('automatic command configuration cannot authorize readonly or restricted folder shells', async () => {
  const { root, grant } = await fixture()
  const guardDirectory = path.join(root, 'guard')
  const writable = { ...grant, writable: true }
  const readonly = buildOpenCodeV2Config([grant], grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, guardDirectory, true, true)
  const restricted = buildOpenCodeV2Config([writable], writable, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, guardDirectory, false, true)
  for (const config of [readonly, restricted]) {
    assert.equal(config.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, 'deny')
    assert.equal(config.agents.build.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, 'deny')
    assert.equal(config.experimental.policies.findLast(rule => rule.resource === 'shell:*')?.effect, 'deny')
  }
  const { invoke } = await fixture(true, { allowShell: false })
  await assert.rejects(invoke('shell', { command: 'echo qa' }), /restricted folder scope/)
})

test('commands are never approved automatically while any folder in scope is read only', async () => {
  const { root, directory, grant, grants, readonlyDirectory, invoke } = await fixture(true, { readonlyChild: true })
  const config = buildOpenCodeV2Config(grants, grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, path.join(root, 'guard'), true, true)
  // A command such as `Remove-Item ..\readonly -Recurse` could reach the read-only folder.
  assert.equal(config.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, 'ask')
  const allWritable = grants.map(item => ({ ...item, writable: true }))
  const writableConfig = buildOpenCodeV2Config(allWritable, grant, 'qa-model', 'http://127.0.0.1:1111/v1', undefined, undefined, path.join(root, 'guard'), true, true)
  assert.equal(writableConfig.permissions.findLast(rule => rule.action === 'shell' && rule.resource === '*')?.effect, 'allow')
  assert.equal((await invoke('shell', { command: 'echo qa' }) as Record<string, unknown>).workdir, directory)
  await assert.rejects(invoke('shell', { command: 'echo qa', workdir: readonlyDirectory }), /writable/)
  await assert.rejects(invoke('shell', { command: 'echo qa', workdir: root }), /authorized/)
})

test('V2 free configuration binds one native public model and never configures a paid fallback', async () => {
  const { root, grant } = await fixture()
  const freeModel: OpenCodeFreeModel = { id: 'opencode-free/test-free', apiModel: 'test-free', name: 'Test', contextLimit: 200000, outputLimit: 8000, toolCall: true, vision: false, reasoning: true, temperature: true, sdk: '@ai-sdk/openai-compatible', protocol: 'chat-completions' }
  const config = buildOpenCodeV2Config([grant], grant, freeModel.id, '', undefined, freeModel, path.join(root, 'guard'))
  assert.deepEqual(Object.keys(config.providers), ['opencode'])
  assert.deepEqual(config.model, { providerID: 'opencode', model: 'test-free' })
  assert.equal(config.providers.opencode.settings.apiKey, 'public')
  assert.equal(config.providers.opencode.settings.baseURL, 'https://opencode.ai/inference/openai/v1')
  assert.deepEqual(Object.keys(config.providers.opencode.models), ['test-free'])
  assert.equal(config.providers.opencode.models['test-free'].cost?.input, 0)
})

test('V2 uses the resolved upstream model and native provider protocol without the external proxy', async () => {
  const { root, grant } = await fixture()
  for (const protocol of ['openai', 'anthropic'] as const) {
    const connection = { baseURL: 'https://models.example.test/api/v1', apiKey: 'not-written-to-config', model: 'upstream-model', protocol, direct: true, headers: { 'X-Project': '{env:DAILYWORKMATE_MODEL_HEADER_0}' } }
    const config = buildOpenCodeV2Config([grant], grant, 'display-alias', '', undefined, undefined, path.join(root, 'guard'), true, false, connection)
    assert.deepEqual(config.model, { providerID: 'dailyworkmate', model: 'upstream-model' })
    assert.equal(config.providers.dailyworkmate.settings.baseURL, connection.baseURL)
    assert.equal(config.providers.dailyworkmate.package, protocol === 'anthropic' ? '@opencode/ai/providers/anthropic' : '@opencode/ai/providers/openai-compatible')
    assert.deepEqual(config.providers.dailyworkmate.headers, connection.headers)
    assert.equal(config.plugins[0].options.modelID, connection.model, 'the workspace guard allows precisely the resolved model')
    assert.doesNotMatch(JSON.stringify(config), /not-written-to-config|11434|X-DailyWorkMate-Model-Selection/)
  }
})

test('V2 guard rewrites valid paths, denies readonly modifications and every unrecognized tool', async () => {
  const { directory, invoke } = await fixture()
  assert.deepEqual(await invoke('read', { path: 'note.txt' }), { path: path.join(directory, 'note.txt') })
  await assert.rejects(invoke('write', { path: 'new.txt', content: 'x' }), /writable/)
  await assert.rejects(invoke('patch', { patchText: '*** Begin Patch\n*** Delete File: note.txt\n*** End Patch' }), /writable/)
  await assert.rejects(invoke('shell', { command: 'echo qa' }), /read-only/)
  await assert.rejects(invoke('webfetch', { url: 'https://example.org' }), /unsupported/)
  await assert.rejects(invoke('read', { path: '../outside.txt' }), /authorized/)
  await assert.rejects(invoke('read', { path: 'note.txt:secret' }), /alternate streams/)
  await assert.rejects(invoke('read', { path: 'missing' }), /ENOENT/)
})

test('V2 guard denies secret files, recursive grep exposure, glob traversal and escaping links', async () => {
  const { root, directory, invoke, search } = await fixture()
  await writeFile(path.join(directory, '.env'), 'DO_NOT_READ=synthetic')
  await assert.rejects(invoke('read', { path: '.env' }), /sensitive/)
  const result = await search('grep', { pattern: 'synthetic', path: '.', hidden: true })
  assert.match(result.content, /note.txt:1: synthetic note/)
  assert.doesNotMatch(result.content, /DO_NOT_READ|\.env/)
  await mkdir(path.join(directory, 'node_modules'))
  await writeFile(path.join(directory, 'node_modules', 'ignored.txt'), 'synthetic dependency')
  assert.doesNotMatch((await search('glob', { pattern: '**/*.txt' })).content, /ignored.txt/)
  await assert.rejects(invoke('glob', { pattern: '../*' }), /inside/)
  await assert.rejects(invoke('glob', { pattern: '{../outside,*.txt}' }), /inside/)
  await mkdir(path.join(root, 'outside'))
  await symlink(path.join(root, 'outside'), path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(invoke('read', { path: 'escape' }), /authorized/)
})

test('V2 writable guard validates all patch paths and shell working directories', async () => {
  const { root, directory, invoke } = await fixture(true)
  assert.deepEqual(await invoke('write', { path: 'new.txt', content: 'x' }), { path: path.join(directory, 'new.txt'), content: 'x' })
  await assert.rejects(invoke('patch', { patchText: '*** Begin Patch\n*** Update File: note.txt\n*** Move to: ../escaped.txt\n@@\n-a\n+b\n*** End Patch' }), /authorized/)
  await assert.rejects(invoke('shell', { command: 'echo qa', workdir: root }), /authorized/)
  await assert.rejects(invoke('shell', { command: 'echo qa', background: true }), /background/)
  const guarded = await invoke('shell', { command: 'echo qa', timeout: 0 }) as Record<string, unknown>
  assert.equal(guarded.workdir, directory)
  assert.equal(guarded.timeout, 120000)
})

test('V2 guard excludes unselected models and rejects auxiliary requests to them', async () => {
  const { hooks, removed } = await fixture()
  assert.deepEqual(removed, ['dailyworkmate/paid', 'other/paid'])
  await hooks['model.request']({ model: { providerID: 'dailyworkmate', id: 'qa-model' }, kind: 'title' })
  assert.throws(() => hooks['model.request']({ model: { providerID: 'other', id: 'paid' }, kind: 'compaction' }), /unselected/)
})

test('V2 guard installer writes a loadable local JS package and refuses symlink entrypoints', async () => {
  const { root, directory, grant } = await fixture()
  const guardDirectory = path.join(root, 'guard')
  await installWorkspaceGuardV2(guardDirectory, [grant, { ...grant, id: 'offline', path: path.join(root, 'offline-drive') }], directory)
  const manifest = JSON.parse(await readFile(path.join(guardDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal((await import(pathToFileURL(path.join(guardDirectory, 'index.js')).href)).default.id, 'dailyworkmate-workspace-guard-v2')
  const linkedGuard = path.join(root, 'linked-guard')
  await symlink(guardDirectory, linkedGuard, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(installWorkspaceGuardV2(linkedGuard, [grant], directory), /target changed/)
})
