import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { OpenCodeRuntimeUpdates, managedRuntimeExecutable, newerRuntimeVersion, parseRuntimeRelease, rollbackManagedRuntime, runtimeAssetName } from '../../src/main/companion/runtimeUpdates.ts'

const payload = Buffer.from('a trusted archive for controlled runtime update tests')
function release(version = '2.0.24', platform = process.platform, arch = process.arch) {
  const name = runtimeAssetName(platform, arch)
  return { manifest: { version, channel: 'latest', name: 'cli', distribution: 'npm', active: true, metadata: { package: '@opencode/cli' } },
    package: { name: '@opencode/' + name, version, os: [platform], cpu: [arch], dist: {
      tarball: `https://registry.npmjs.org/@opencode/${name}/-/${name}-${version}.tgz`,
      integrity: 'sha512-' + createHash('sha512').update(payload).digest('base64') } } }
}
async function fixture() {
  await mkdir(path.resolve('tmp'), { recursive: true })
  const home = await mkdtemp(path.join(path.resolve('tmp'), 'opencode-update-'))
  const bundled = path.join(home, 'bundled')
  await mkdir(bundled)
  const bundledExecutable = path.join(bundled, 'opencode.exe')
  await writeFile(bundledExecutable, 'old working runtime')
  await writeFile(path.join(bundled, 'runtime-manifest.json'), JSON.stringify({ version: '2.0.23' }))
  return { home, bundledExecutable }
}
const io = {
  release: async () => release(),
  download: async (_release, archive: string) => { await writeFile(archive, payload) },
  extract: async (_archive: string, directory: string, name: string) => { await writeFile(path.join(directory, name), 'new working runtime') },
  probe: async () => 'opencode v2.0.24', now: () => 1_800_000_000_000,
}

test('runtime updates select CPU-compatible official artifacts and only stable releases with a checksum', () => {
  assert.equal(runtimeAssetName('win32', 'x64'), 'cli-windows-x64-baseline')
  assert.equal(runtimeAssetName('darwin', 'arm64'), 'cli-darwin-arm64')
  assert.equal(runtimeAssetName('linux', 'x64', true), 'cli-linux-x64-baseline-musl')
  assert.throws(() => runtimeAssetName('win32', 'ia32'), /unavailable/)
  const input = release()
  assert.equal(parseRuntimeRelease(input).version, '2.0.24')
  assert.throws(() => parseRuntimeRelease({ ...input, manifest: { ...input.manifest, channel: 'beta' } }), /stable/)
  assert.throws(() => parseRuntimeRelease({ ...input, manifest: { ...input.manifest, version: '../../other' } }), /stable/)
  assert.throws(() => parseRuntimeRelease(release('1.18.35')), /V2/)
  assert.throws(() => parseRuntimeRelease(release('3.0.0')), /V2/)
  assert.throws(() => parseRuntimeRelease({ ...input, manifest: { ...input.manifest, metadata: { package: '@attacker/cli' } } }), /source/)
  assert.throws(() => parseRuntimeRelease({ ...input, package: { ...input.package, dist: { ...input.package.dist, tarball: 'https://example.com/opencode.exe' } } }), /URL/)
  assert.throws(() => parseRuntimeRelease({ ...input, package: { ...input.package, dist: { ...input.package.dist, integrity: undefined } } }), /checksum/)
  assert.throws(() => parseRuntimeRelease({ ...input, package: { ...input.package, cpu: ['ia32'] } }), /match/)
  assert.equal(newerRuntimeVersion('2.0.24', '2.0.23'), true)
  assert.equal(newerRuntimeVersion('1.9.99', '2.0.23'), false)
  assert.equal(newerRuntimeVersion('2.0.24', '2.0.24'), false)
  assert.equal(newerRuntimeVersion('2.1.0', '2.0.24'), true)
})

test('daily checks persist across app restarts and share an in-flight request', async () => {
  const options = await fixture()
  let requests = 0
  const mocked = { ...io, release: async () => { requests++; return release() } }
  const updates = new OpenCodeRuntimeUpdates(options, mocked)
  const [first, second] = await Promise.all([updates.check(), updates.check()])
  assert.equal(requests, 1)
  assert.equal(first.currentVersion, '2.0.23')
  assert.equal(first.updateAvailable, true)
  assert.equal(second.checking, false)
  await new OpenCodeRuntimeUpdates(options, mocked).check()
  assert.equal(requests, 1)
  await updates.check(true)
  assert.equal(requests, 2)
  await new OpenCodeRuntimeUpdates(options, { ...mocked, now: () => io.now() + 86_400_001 }).check()
  assert.equal(requests, 3)
})

test('a validated update activates a separate executable without modifying the bundled runtime', async () => {
  const options = await fixture()
  let stopped = false
  const updates = new OpenCodeRuntimeUpdates({ ...options, beforeActivate: () => { stopped = true } }, io)
  const result = await updates.install()
  assert.equal(result.error, '')
  assert.equal(result.source, 'managed')
  assert.equal(result.currentVersion, '2.0.24')
  assert.equal(result.updateAvailable, false)
  assert.equal(result.installing, false)
  assert.equal(stopped, true)
  assert.equal(await readFile(options.bundledExecutable, 'utf8'), 'old working runtime')
  const installed = managedRuntimeExecutable(options.home)
  assert.ok(installed)
  assert.equal(await readFile(installed, 'utf8'), 'new working runtime')
  assert.equal((await new OpenCodeRuntimeUpdates(options, io).status()).currentVersion, '2.0.24')
  assert.equal((await readdir(path.join(options.home, 'runtime', 'managed-opencode-v2'))).some(name => name.startsWith('.staging-')), false)
})

test('install pins a just-checked release and does not repeat the metadata request', async () => {
  const options = await fixture()
  let requests = 0
  const updates = new OpenCodeRuntimeUpdates(options, { ...io, release: async () => {
    requests++
    if (requests > 1) throw new Error('Temporary official update API failure')
    return release()
  } })
  await updates.check(true)
  assert.equal((await updates.install()).currentVersion, '2.0.24')
  assert.equal(requests, 1)
})

test('checksum and executable version failures preserve the previously activated runtime', async () => {
  const options = await fixture()
  await new OpenCodeRuntimeUpdates(options, io).install()
  const previous = managedRuntimeExecutable(options.home)
  const differentPayload = Buffer.from('x'.repeat(payload.length))
  const badArchive = new OpenCodeRuntimeUpdates(options, { ...io, release: async () => release('2.0.25'),
    download: async (_release, archive) => { await writeFile(archive, differentPayload) } })
  assert.match((await badArchive.install()).error, /SHA-512/)
  assert.equal(managedRuntimeExecutable(options.home), previous)
  const badExecutable = new OpenCodeRuntimeUpdates(options, { ...io, release: async () => release('2.0.25') })
  assert.match((await badExecutable.install()).error, /version check/)
  assert.equal(managedRuntimeExecutable(options.home), previous)
  assert.equal(await readFile(previous!, 'utf8'), 'new working runtime')
  assert.equal((await badExecutable.status()).latestVersion, '2.0.25')
})

test('install never interrupts an existing task and rechecks before activation', async () => {
  const options = await fixture()
  let busy = true
  let stopped = false
  const updates = new OpenCodeRuntimeUpdates({ ...options, isBusy: () => busy, beforeActivate: () => { stopped = true } }, {
    ...io, download: async (_release, archive) => { await writeFile(archive, payload); busy = true },
  })
  await assert.rejects(updates.install(), /current workspace task/)
  busy = false
  assert.match((await updates.install()).error, /started during the download/)
  assert.equal(stopped, false)
  assert.equal(managedRuntimeExecutable(options.home), undefined)
  assert.equal((await updates.status()).currentVersion, '2.0.23')
})

test('service startup failure can restore the previous managed runtime or bundled fallback', async () => {
  const options = await fixture()
  await new OpenCodeRuntimeUpdates(options, io).install()
  const previous = managedRuntimeExecutable(options.home)
  const newer = new OpenCodeRuntimeUpdates(options, { ...io, release: async () => release('2.0.25'), probe: async () => 'opencode v2.0.25' })
  assert.equal((await newer.install()).currentVersion, '2.0.25')
  assert.notEqual(managedRuntimeExecutable(options.home), previous)
  await rollbackManagedRuntime(options.home)
  assert.equal(managedRuntimeExecutable(options.home), previous)
  assert.equal((await newer.status()).currentVersion, '2.0.24')
  await rollbackManagedRuntime(options.home)
  assert.equal(managedRuntimeExecutable(options.home), undefined)
  assert.equal((await newer.status()).currentVersion, '2.0.23')
  assert.equal(await readFile(previous!, 'utf8'), 'new working runtime')
})

test('missing managed binaries and traversal metadata fall back to the bundled runtime', async () => {
  const options = await fixture()
  const root = path.join(options.home, 'runtime', 'managed-opencode-v2')
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'active.json'), JSON.stringify({ version: '2.0.24', platform: process.platform, arch: process.arch, directory: '../../../outside' }))
  assert.equal(managedRuntimeExecutable(options.home), undefined)
  assert.equal((await new OpenCodeRuntimeUpdates(options, io).status()).source, 'bundled')
})
