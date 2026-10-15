// Real Electron safeStorage and disk persistence, isolated from personal application data.
const { app, safeStorage } = require('electron')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const scratch = path.join(root, 'tmp', 'companion-storage-' + process.pid)
fs.mkdirSync(scratch, { recursive: true })
app.setPath('userData', path.join(scratch, 'profile'))
process.env.DAILYWORKMATE_COMPANION_HOME = scratch
app.whenReady().then(async () => {
  buildSync({ entryPoints: [path.join(root, 'src/main/companion/storage.ts')], outfile: path.join(scratch, 'storage.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const { CompanionStorage } = require(path.join(scratch, 'storage.cjs'))
  const storage = new CompanionStorage()
  const initial = await storage.get()
  assert.equal(initial.messages.length, 0)
  const key = 'q'.repeat(4096)
  const messages = [
    { id: 'qa', role: 'user', content: 'persist me', mode: 'chat', createdAt: 1 },
    { id: 'refusal', role: 'assistant', content: 'refused', mode: 'chat', createdAt: 2, model: 'minimax-m3:cloud' },
    { id: 'retry', role: 'assistant', content: 'read completed', mode: 'chat', createdAt: 3, model: 'opencode/ling-3.1-flash-free', retryOf: 'refusal' },
  ]
  const canEncrypt = safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  const settings = { ...initial.settings, name: 'Persistent companion', stt: { ...initial.settings.stt, apiKey: canEncrypt ? key : '' } }
  await Promise.all([storage.saveSettings(settings), storage.saveMessages(messages)])
  const restored = await new CompanionStorage().get()
  assert.equal(restored.settings.name, settings.name)
  assert.deepEqual(restored.messages, messages)
  assert.throws(() => storage.saveMessages([{ ...messages[2], model: 'bad\nmodel' }]), /Invalid message model/)
  assert.throws(() => storage.saveMessages([{ ...messages[2], retryOf: 'x'.repeat(81) }]), /Invalid retry message ID/)
  assert.deepEqual((await new CompanionStorage().get()).messages, messages, 'invalid attribution preserves saved history')
  if (canEncrypt) {
    assert.equal(restored.settings.stt.apiKey, key)
    assert.ok(!fs.readFileSync(path.join(scratch, 'data', 'companion.json'), 'utf8').includes(key))
  } else {
    await assert.rejects(storage.saveSettings({ ...settings, stt: { ...settings.stt, apiKey: key } }), /Secure key storage/)
  }
  fs.mkdirSync(path.join(scratch, 'workspace'))
  await storage.addWorkspace(path.join(scratch, 'workspace'))
  const grant = (await storage.get()).workspaces[0]
  assert.equal(grant.writable, false)
  await storage.updateWorkspace(grant.id, true)
  assert.equal((await storage.grant(grant.id)).writable, true)
  await storage.saveWorkspaceGroup({ name: 'Research', workspaceIds: [grant.id] })
  const group = (await storage.get()).groups[0]
  assert.deepEqual((await new CompanionStorage().get()).groups, [group])
  await assert.rejects(storage.saveWorkspaceGroup({ name: 'Invalid', workspaceIds: ['unauthorized'] }), /unauthorized/)
  await storage.updateWorkspace(grant.id, null)
  await assert.rejects(storage.grant(grant.id), /not authorized/)
  assert.deepEqual((await storage.get()).groups[0].workspaceIds, [])
  assert.ok(fs.existsSync(path.join(scratch, 'workspace')), 'revoking a grant preserves disk files')
  await storage.deleteWorkspaceGroup(group.id)
  assert.deepEqual((await new CompanionStorage().get()).groups, [])
  await storage.setAvatarModel(path.join(root, 'deliverables', 'pink-ai-octopus.glb'))
  const modelSettings = (await new CompanionStorage().get()).settings
  assert.equal(modelSettings.avatarMode, '3d')
  assert.equal(modelSettings.avatarVisible, true)
  assert.match(await storage.avatarModelUrl(), /^data:model\/gltf-binary;base64,/)
  await storage.saveSettings({ ...modelSettings, avatarVisible: false, avatarModel: '../invalid.glb' })
  const hidden = (await new CompanionStorage().get()).settings
  assert.equal(hidden.avatarVisible, false)
  assert.equal(hidden.avatarModel, modelSettings.avatarModel, 'ordinary settings cannot change an imported model path')
  const invalidModel = path.join(scratch, 'invalid.glb')
  fs.writeFileSync(invalidModel, 'not a GLB')
  await assert.rejects(storage.setAvatarModel(invalidModel), /GLB/)
  assert.equal((await storage.get()).settings.avatarModel, modelSettings.avatarModel)
  await storage.resetAvatarModel()
  assert.equal((await new CompanionStorage().get()).settings.avatarModel, '')
  console.log('PASS: atomic saves, history/settings recovery, encrypted keys, grouped grants/revocation, GLB import/hide/reset and failed-import preservation')
}).catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => app.exit(process.exitCode || 0))
