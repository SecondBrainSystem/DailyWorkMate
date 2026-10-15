import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, symlink } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_COMPANION_SETTINGS, speechUrl, validateSettings } from '../../src/shared/companion.ts'
import { isWithin, resolveWorkspacePath, readWorkspaceFile, listWorkspaceFiles } from '../../src/main/companion/workspaces.ts'
import { buildOpenCodeConfig, proxyConnection } from '../../src/main/companion/opencodeConfig.ts'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import { workspaceGuardSource } from '../../src/main/companion/workspaceGuard.ts'

test('folder boundaries distinguish siblings, absolute paths and traversal', async () => {
  const parent = await mkdtemp(path.join(path.resolve('tmp'), 'companion-paths-'))
  await mkdir(path.join(parent, 'allowed'))
  await mkdir(path.join(parent, 'allowed-other'))
  const root = await realpath(path.join(parent, 'allowed'))
  const grant = { id: 'test', name: 'test', path: root, writable: false }
  await writeFile(path.join(root, 'notes.txt'), '你好 companion')
  assert.equal(await readWorkspaceFile(grant, 'notes.txt'), '你好 companion')
  assert.equal(isWithin(root, path.join(parent, 'allowed-other')), false)
  await assert.rejects(resolveWorkspacePath(grant, '../allowed-other'), /inside/)
  await assert.rejects(resolveWorkspacePath(grant, '..\\allowed-other'), /inside/)
  await assert.rejects(resolveWorkspacePath(grant, path.join(parent, 'allowed-other')), /inside/)
  await assert.rejects(resolveWorkspacePath(grant, 'notes.txt:secret'), /inside/)
  await symlink(path.join(parent, 'allowed-other'), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveWorkspacePath(grant, 'escape'), /outside/)
  assert.equal((await listWorkspaceFiles(grant, '')).some(entry => entry.name === 'escape'), false)
})

test('attachment reader rejects binary and oversized files', async () => {
  const root = await realpath(await mkdtemp(path.join(path.resolve('tmp'), 'companion-files-')))
  const grant = { id: 'test', name: 'test', path: root, writable: false }
  await writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]))
  await writeFile(path.join(root, 'large'), Buffer.alloc(512 * 1024 + 1, 65))
  await assert.rejects(readWorkspaceFile(grant, 'binary'), /Binary/)
  await assert.rejects(readWorkspaceFile(grant, 'large'), /512/)
})

test('speech URLs allow local services and HTTPS without embedded credentials', () => {
  assert.equal(speechUrl('http://127.0.0.1:8080/v1/', 'speech'), 'http://127.0.0.1:8080/v1/audio/speech')
  assert.equal(speechUrl('https://speech.example/v1', 'transcriptions'), 'https://speech.example/v1/audio/transcriptions')
  for (const url of ['file:///etc/passwd', 'http://remote.example/v1', 'https://user:pass@remote.example', 'https://remote.example/?key=secret']) {
    assert.throws(() => speechUrl(url, 'speech'))
  }
})

test('settings validate service responses and do not mutate defaults', () => {
  assert.equal(validateSettings({ ...DEFAULT_COMPANION_SETTINGS, speechEnabled: false }).speechEnabled, false)
  assert.equal(validateSettings({ ...DEFAULT_COMPANION_SETTINGS, speechEnabled: undefined } as unknown as typeof DEFAULT_COMPANION_SETTINGS).speechEnabled, true)
  assert.throws(() => validateSettings({ ...DEFAULT_COMPANION_SETTINGS, speechEnabled: 'false' } as unknown as typeof DEFAULT_COMPANION_SETTINGS), /speech switch/)
  assert.throws(() => validateSettings({ ...DEFAULT_COMPANION_SETTINGS, speechRate: 9 }), /rate/)
  assert.throws(() => validateSettings({ ...DEFAULT_COMPANION_SETTINGS, name: '' }), /name/)
  const checked = validateSettings(DEFAULT_COMPANION_SETTINGS)
  assert.notEqual(checked, DEFAULT_COMPANION_SETTINGS)
  assert.notEqual(checked.stt, DEFAULT_COMPANION_SETTINGS.stt)
})

test('only the exact retired companion persona migrates and custom personas survive unchanged', () => {
  const retiredPersona = '你是小伴，一位友好、可靠的虚拟伙伴。用用户使用的语言自然地回答，根据问题需要提供完整的解释，不必为了朗读缩短文字。普通聊天不能访问文件或执行操作；如需操作文件，请引导用户切换到工作模式。不要声称完成了未执行的操作。'
  const saved = Object.freeze({ ...DEFAULT_COMPANION_SETTINGS, persona: retiredPersona })
  const migrated = validateSettings(saved)
  assert.equal(migrated.persona, DEFAULT_COMPANION_SETTINGS.persona)
  assert.notEqual(migrated.persona, retiredPersona)
  assert.equal(saved.persona, retiredPersona, 'reading settings must not overwrite the stored object')
  for (const persona of [retiredPersona + '\n自定义：请先解释操作目的。', '你是我的论文助手，请优先使用中文。', '']) {
    assert.equal(validateSettings({ ...saved, persona }).persona, persona, 'user-authored character instructions must be preserved')
  }
})

test('proxy authentication fails closed and wildcard bind hosts resolve locally', () => {
  assert.deepEqual(proxyConnection({ proxyHost: '::', proxyPort: 11434, enableApiKey: false, apiKeys: [] }), { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'dailyworkmate-local' })
  assert.throws(() => proxyConnection({ proxyHost: 'localhost', proxyPort: 10, enableApiKey: true, apiKeys: [] }), /API key/)
  assert.equal(proxyConnection({ proxyHost: '::1', proxyPort: 10, enableApiKey: true, apiKeys: [{ key: 'secret', enabled: true }] }).baseURL, 'http://[::1]:10/v1')
})

test('OpenCode gives read-only workspaces no shell or edit authority and keeps keys out of disk config', () => {
  const grant = { id: 'a', name: 'docs', path: path.resolve('tmp/docs'), writable: false }
  const config = buildOpenCodeConfig([grant], grant, 'qa-model', 'http://127.0.0.1:11434/v1')
  assert.equal(config.permission.bash, 'deny')
  assert.equal(config.permission.edit[grant.path.replace(/\\/g, '/') + '/*'], 'deny')
  assert.equal(config.permission.external_directory['*'], 'deny')
  assert.equal(config.permission['*'], 'deny')
  assert.equal(config.provider.dailyworkmate.options.apiKey, '{env:DAILYWORKMATE_PROXY_KEY}')
  const writable = { ...grant, writable: true }
  assert.equal(buildOpenCodeConfig([writable], writable, 'qa-model', 'http://localhost:11434/v1').permission.bash, 'ask')
})

test('speech adapter uploads recorded audio, receives speech, rejects invalid audio and cancels requests', async () => {
  const directory = await mkdtemp(path.join(path.resolve('tmp'), 'companion-speech-boundary-'))
  const output = path.join(directory, 'speech.mjs')
  await build({ entryPoints: ['src/main/companion/speech.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{
    name: 'speech-test-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const app = {isPackaged:false,getAppPath:()=>process.cwd()}' }))
    },
  }] })
  const { SpeechService } = await import(pathToFileURL(output).href)
  let requestBody = ''
  const service = new SpeechService()
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const bytes of req) body += bytes.toString()
    requestBody = body
    if (req.url === '/v1/audio/transcriptions') {
      assert.match(req.headers['content-type'] || '', /multipart\/form-data/)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ text: '你好，伙伴' }))
    } else if (body.includes('WAIT')) { /* wait for cancellation */ }
    else { res.setHeader('content-type', 'audio/mpeg'); res.end('FAKE_AUDIO') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const endpoint = { baseUrl: 'http://127.0.0.1:' + address.port + '/v1', model: 'test-model', apiKey: '' }
  const settings = { ...DEFAULT_COMPANION_SETTINGS, sttMode: 'api' as const, ttsMode: 'api' as const, stt: endpoint, tts: endpoint }
  try {
    assert.equal(await service.transcribe(settings, new Uint8Array([1, 2, 3]), 'audio/webm;codecs=opus'), '你好，伙伴')
    assert.match(requestBody, /recording.webm/)
    assert.match(requestBody, /test-model/)
    assert.equal((await service.synthesize(settings, 'hello')).mime, 'audio/mpeg')
    await assert.rejects(service.transcribe(settings, new Uint8Array(), 'audio/webm'), /Audio/)
    await assert.rejects(service.transcribe(settings, new Uint8Array([1]), 'text/html'), /Unsupported/)
    const pending = service.synthesize(settings, 'WAIT')
    setTimeout(() => service.cancel(), 30)
    await assert.rejects(pending, /cancelled/)
  } finally { service.cancel(); server.closeAllConnections(); server.close() }
})

test('OpenCode guard rejects symlink escapes, out-of-folder edits and multi-file patch escapes', async () => {
  const parent = await realpath(await mkdtemp(path.join(path.resolve('tmp'), 'companion-guard-')))
  const root = path.join(parent, 'workspace')
  const outside = path.join(parent, 'private')
  await mkdir(root); await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'secret')
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const grant = { id: 'a', path: root, name: 'root', writable: true }
  const source = workspaceGuardSource([grant], root)
  const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const hooks = await plugin.default()
  const run = (tool: string, args: unknown) => hooks['tool.execute.before']({ tool }, { args })
  await run('write', { filePath: 'new-folder/new.txt' })
  await assert.rejects(run('read', { filePath: 'link/secret.txt' }), /Workspace guard/)
  await assert.rejects(run('write', { filePath: '../private/new.txt' }), /Workspace guard/)
  await assert.rejects(run('apply_patch', { patchText: '*** Begin Patch\n*** Add File: ok.txt\n+ok\n*** Add File: ../private/no.txt\n+no\n*** End Patch' }), /Workspace guard/)
  const readonly = await import('data:text/javascript;base64,' + Buffer.from(workspaceGuardSource([{ ...grant, writable: false }], root)).toString('base64'))
  await assert.rejects((await readonly.default())['tool.execute.before']({ tool: 'write' }, { args: { filePath: 'new.txt' } }), /writable/)
})
