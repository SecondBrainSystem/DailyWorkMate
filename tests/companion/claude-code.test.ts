import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { ClaudeCodeTerminalService, ClaudeStreamState, claudeCodeArgs, claudeCodeEnvironment, claudeProjectKey, claudeSessionId, findClaudeCode, prepareClaudeConfig } from '../../src/main/companion/claudeCode.ts'

const proxy = { proxyHost: '0.0.0.0', proxyPort: 11434, enableApiKey: true, apiKeys: [{ key: 'local-key', enabled: true }] }
const folder = (id: string, writable: boolean) => ({ id, name: id, path: path.resolve('/work', id), writable })

test('Claude Code is found as a native install or through the npm package, never via cmd.exe', () => {
  const home = 'C:\\Users\\qa'
  const native = path.join(home, '.local', 'bin', 'claude.exe')
  assert.equal(findClaudeCode({ USERPROFILE: home, PATH: '' }, 'win32', file => file === native)?.file, native)
  const shim = path.join('C:\\npm', 'claude.cmd')
  const script = path.join('C:\\npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  const viaNpm = findClaudeCode({ USERPROFILE: home, Path: 'C:\\npm' }, 'win32', file => file === shim || file === script)
  assert.deepEqual([viaNpm?.file, viaNpm?.prefix, viaNpm?.env], [process.execPath, [script], { ELECTRON_RUN_AS_NODE: '1' }])
  assert.equal(findClaudeCode({ USERPROFILE: home, PATH: 'C:\\npm' }, 'win32', file => file === shim), null, 'a bare batch shim is not executed')
  assert.equal(findClaudeCode({ HOME: '/home/qa', PATH: '' }, 'linux', () => false), null)
})

test('Claude Code talks only to the local proxy with the chosen model and an isolated config folder', () => {
  const env = claudeCodeEnvironment({ PATH: 'x', ANTHROPIC_API_KEY: 'personal', ANTHROPIC_BASE_URL: 'https://elsewhere', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1' }, proxy, 'gemma4:31b-cloud', 'C:/data/claude')
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-key')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined)
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) assert.equal(env[name], 'gemma4:31b-cloud')
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:/data/claude')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(env.PATH, 'x')
  assert.throws(() => claudeCodeEnvironment({}, { ...proxy, apiKeys: [] }, 'm', 'c'), /Enable an API key/)
})

test('Claude Code uses native Messages credentials and mapped model without inheriting another account', () => {
  const connection = { baseURL: 'https://models.example.test/api/v1', apiKey: 'upstream-key', model: 'actual-claude', protocol: 'anthropic' as const, direct: true, headers: { 'X-Project': 'team' } }
  const env = claudeCodeEnvironment({ ANTHROPIC_AUTH_TOKEN: 'old-proxy-key', ANTHROPIC_CUSTOM_HEADERS: 'X-Old: secret' }, connection, 'display-alias', 'C:/test/config')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://models.example.test/api')
  assert.equal(env.ANTHROPIC_API_KEY, 'upstream-key')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env.ANTHROPIC_MODEL, 'actual-claude')
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-Project: team')
  assert.throws(() => claudeCodeEnvironment({}, { ...connection, protocol: 'openai' }, 'alias', 'config'), /Anthropic-compatible/)
  assert.throws(() => claudeCodeEnvironment({}, { ...connection, headers: { 'X-Project': 'team\r\nInjected: yes' } }, 'alias', 'config'), /Invalid Claude Code model headers/)
})

test('folder permissions become hard Claude Code tool limits', () => {
  const read = folder('read', false), edit = folder('edit', true), other = folder('other', true)
  const base = { model: 'm', sessionId: '00000000-0000-4000-8000-000000000000', resume: false }
  const readOnly = claudeCodeArgs({ ...base, print: true, scope: { directory: read.path, grants: [read], writable: false, commands: false } })
  assert.equal(readOnly[readOnly.indexOf('--disallowedTools') + 1], 'Edit,Write,MultiEdit,NotebookEdit,EnterWorktree,ExitWorktree,Bash,PowerShell')
  assert.ok(!readOnly.includes('--permission-mode') && !readOnly.includes('--allowedTools'))
  assert.ok(readOnly.includes('--strict-mcp-config') && readOnly[readOnly.indexOf('--setting-sources') + 1] === 'user', 'folder settings and MCP servers are not loaded')
  assert.deepEqual(readOnly.slice(readOnly.indexOf('--session-id'), readOnly.indexOf('--session-id') + 2), ['--session-id', base.sessionId])

  const chat = claudeCodeArgs({ ...base, print: true, resume: true, scope: { directory: edit.path, grants: [edit, other], writable: true, commands: true }, systemPrompt: 'persona' })
  assert.ok(!chat.includes('--disallowedTools'))
  assert.equal(chat[chat.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(chat[chat.indexOf('--allowedTools') + 1], 'Bash,PowerShell')
  assert.deepEqual(chat.slice(chat.indexOf('--add-dir'), chat.indexOf('--add-dir') + 2), ['--add-dir', other.path])
  assert.deepEqual(chat.slice(chat.indexOf('--resume'), chat.indexOf('--resume') + 2), ['--resume', base.sessionId])
  assert.equal(chat.at(-1), 'persona')

  const subfolder = claudeCodeArgs({ ...base, print: false, scope: { directory: path.join(edit.path, 'docs'), grants: [edit], writable: true, commands: false } })
  assert.equal(subfolder[subfolder.indexOf('--disallowedTools') + 1], 'Bash,PowerShell')
  assert.ok(!subfolder.includes('-p') && !subfolder.includes('--permission-mode'), 'the Work TUI asks before edits')
})

test('Claude Code session IDs stay in their folder scope', () => {
  assert.equal(claudeSessionId('', 'scope'), '')
  assert.equal(claudeSessionId('v2:ses_abc', 'scope'), '', 'an OpenCode session starts a new Claude Code session')
  const env = { sessionId: '' }
  const state = new ClaudeStreamState()
  state.accept({ type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' })
  env.sessionId = state.sessionId
  assert.equal(env.sessionId, '11111111-2222-4333-8444-555555555555')
  assert.throws(() => claudeSessionId('cc:0000000000000000:' + env.sessionId, 'scope'), /another workspace scope/)
})

test('authorized folders are recorded as trusted without losing Claude Code state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-config-'))
  try {
    const file = path.join(dir, '.claude.json')
    await writeFile(file, JSON.stringify({ userID: 'keep', projects: { 'C:/other': { lastCost: 1 } } }))
    await prepareClaudeConfig(dir, ['C:\\Work\\Todo', 'C:\\Work\\Todo'])
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.userID, 'keep')
    assert.equal(saved.hasCompletedOnboarding, true)
    assert.deepEqual(saved.projects['C:/other'], { lastCost: 1 })
    assert.equal(saved.projects[claudeProjectKey('C:\\Work\\Todo')].hasTrustDialogAccepted, true)
    if (process.platform === 'win32') assert.ok(saved.projects['C:/Work/Todo'], 'Claude Code uses forward-slash keys')
    await writeFile(file, '{broken')
    await assert.rejects(prepareClaudeConfig(dir, ['C:\\Work']), /Cannot read the Claude Code config/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stream-json output becomes chat text, tool activity and errors', () => {
  const state = new ClaudeStreamState()
  state.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  state.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading ' } } })
  assert.equal(state.snapshot().text, 'Reading ')
  state.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the file.' }] } })
  state.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/work/tasks.json' } }] } })
  assert.deepEqual(state.snapshot().tools, [{ id: 't1', name: 'Read', status: 'running', title: 'C:/work/tasks.json' }])
  assert.equal(state.snapshot().phase, 'tool')
  state.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
  state.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'The latest task is QA.' }] } })
  state.accept({ type: 'result', subtype: 'success', is_error: false, result: 'The latest task is QA.' })
  assert.deepEqual(state.snapshot().text, 'Reading the file.\n\nThe latest task is QA.')
  assert.equal(state.snapshot().tools[0].status, 'completed')
  assert.deepEqual(state.result, { error: false, text: 'The latest task is QA.' })

  const failed = new ClaudeStreamState()
  failed.accept({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 401' })
  assert.deepEqual(failed.result, { error: true, text: 'API Error: 401' })
  assert.equal(failed.snapshot().text, '')
})

test('Claude terminal reports pending startup and clears it only after the original process starts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-terminal-startup-'))
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let spawns = 0
  const service = new ClaudeCodeTerminalService({ home: dir, get: async () => {
    await wait
    return { workspaces: [{ id: 'qa', name: 'qa', path: dir, writable: false }] }
  } }, () => proxy, () => () => {
    spawns++
    return { write() {}, resize() {}, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }
  }, () => ({ file: 'claude.exe', prefix: [], display: 'Claude fixture' }))
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  try {
    const pending = service.open({ terminalId: id, workspaceId: 'qa', model: 'qa-model', cols: 100, rows: 30 })
    const waiting = service.poll(id, 0)
    assert.equal(waiting.starting, true)
    assert.equal(waiting.running, false)
    assert.equal(waiting.sessionId, '')
    assert.equal(spawns, 0)
    assert.throws(() => service.write(id, 'x'), /still starting/)
    release()
    const opened = await pending
    assert.equal(opened.starting, false)
    assert.equal(opened.running, true)
    assert.equal(spawns, 1)
  } finally {
    release()
    await service.close()
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('failed Claude startup removes its pending snapshot so it cannot be mistaken for a live task', async () => {
  let fail!: (reason: Error) => void
  const waiting = new Promise<never>((_resolve, reject) => { fail = reject })
  const service = new ClaudeCodeTerminalService({ home: process.cwd(), get: () => waiting }, () => proxy,
    () => () => { throw new Error('The PTY must not launch') },
    () => ({ file: 'claude.exe', prefix: [], display: 'Claude fixture' }))
  const id = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
  const pending = service.open({ terminalId: id, workspaceId: 'qa', model: 'qa-model', cols: 100, rows: 30 })
  assert.equal(service.poll(id, 0).starting, true)
  fail(new Error('Cannot load workspace permissions'))
  await assert.rejects(pending, /Cannot load workspace permissions/)
  assert.throws(() => service.poll(id, 0), /Terminal is no longer active/)
})

test('Claude Work launches the resolved upstream model without requiring the API forwarding listener', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-direct-model-'))
  const connection = { baseURL: 'https://messages.example.test/v1', apiKey: 'synthetic-native-key', model: 'actual-model', protocol: 'anthropic' as const, direct: true }
  let launched: { args: string[]; env: Record<string, string> } | undefined
  const service = new ClaudeCodeTerminalService({ home: dir, get: async () => ({ workspaces: [{ id: 'qa', name: 'qa', path: dir, writable: false }] }) },
    () => { throw new Error('External proxy must not be read') },
    () => (_file, args, options) => {
      launched = { args, env: options.env }
      return { write() {}, resize() {}, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }
    }, () => ({ file: 'claude.exe', prefix: [], display: 'Claude fixture' }), async model => {
      assert.equal(model, 'display-model')
      return connection
    })
  try {
    const result = await service.open({ workspaceId: 'qa', model: 'display-model', cols: 100, rows: 30 })
    assert.equal(result.running, true)
    assert.ok(launched)
    assert.equal(launched.args[launched.args.indexOf('--model') + 1], 'actual-model')
    assert.equal(launched.env.ANTHROPIC_BASE_URL, 'https://messages.example.test')
    assert.equal(launched.env.ANTHROPIC_API_KEY, 'synthetic-native-key')
  } finally {
    await service.close()
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    await rm(dir, { recursive: true, force: true })
  }
})
