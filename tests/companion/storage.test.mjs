import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/companion-storage.mjs')
let CompanionStorage
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    entryPoints: ['src/main/companion/storage.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'electron-mock', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `
        export const app = { isPackaged: false, getAppPath: () => process.cwd(), getLocale: () => 'en-US', getPath: () => process.cwd() }
        export const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
          encryptString: value => Buffer.from(value), decryptString: value => value.toString() }` }))
    } }],
  })
  ;({ CompanionStorage } = await import(pathToFileURL(output).href))
})

async function storageWith(state) {
  await mkdir(path.resolve('tmp'), { recursive: true })
  const home = await mkdtemp(path.join(path.resolve('tmp'), 'companion-storage-'))
  await mkdir(path.join(home, 'data'), { recursive: true })
  if (state) await writeFile(path.join(home, 'data', 'companion.json'), JSON.stringify(state))
  process.env.DAILYWORKMATE_COMPANION_HOME = home
  try { return { home, storage: new CompanionStorage() } } finally { delete process.env.DAILYWORKMATE_COMPANION_HOME }
}
const settings = { name: 'DailyWorkMate', persona: '', model: '', autoSpeak: false, ttsMode: 'local', language: 'en-US', systemVoice: '', voice: 'alloy', speechRate: 1,
  avatar: '', stt: { baseUrl: '', model: 'whisper-1', apiKey: '' }, tts: { baseUrl: '', model: 'tts-1', apiKey: '' } }

test('unreadable legacy messages are dropped without resetting folder grants', async () => {
  const workspace = path.resolve('tmp')
  const { storage } = await storageWith({ nameVersion: 1, settings, groups: [], workspaces: [{ id: 'qa', name: 'qa', path: workspace, writable: true }],
    messages: Array.from({ length: 201 }, (_, index) => ({ id: 'm' + index, role: 'user', content: 'x', mode: 'chat', createdAt: 1 })) })
  const saved = await storage.get()
  assert.equal(saved.workspaces.length, 1, 'folder grants survive')
  assert.deepEqual(saved.messages, [])
  assert.match(storage.warnings.join('\n'), /Legacy chat messages/)
  assert.doesNotMatch(storage.warnings.join('\n'), /authorize folders again/)
})

test('legacy messages keep tool activity and errors for migration', async () => {
  const tools = [{ id: 'read', name: 'read', status: 'completed', title: 'README.md' }]
  const { storage } = await storageWith({ nameVersion: 1, settings, groups: [], workspaces: [],
    messages: [{ id: 'a', role: 'assistant', content: 'Done', mode: 'agent', createdAt: 1, tools, toolStatus: 'used', error: 'partial' }] })
  const [message] = (await storage.get()).messages
  assert.deepEqual(message.tools, tools); assert.equal(message.toolStatus, 'used'); assert.equal(message.error, 'partial')
})

test('the 2D avatar is encoded once and re-read only after the file changes', async () => {
  const { home, storage } = await storageWith({ nameVersion: 1, settings: { ...settings, avatar: 'avatar.png' }, groups: [], workspaces: [], messages: [] })
  const file = path.join(home, 'data', 'avatar.png')
  await writeFile(file, Buffer.from('first'))
  const first = await storage.avatarUrl()
  assert.equal(first, 'data:image/png;base64,' + Buffer.from('first').toString('base64'))
  assert.equal(await storage.avatarUrl(), first)
  await writeFile(file, Buffer.from('second!'))
  await utimes(file, new Date(), new Date(Date.now() + 5000))
  assert.equal(await storage.avatarUrl(), 'data:image/png;base64,' + Buffer.from('second!').toString('base64'))
})
