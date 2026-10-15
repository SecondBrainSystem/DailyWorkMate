import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import axios from 'axios'

// V2 publishes official tags and @opencode/cli packages, not GitHub Releases.
// The legacy GitHub /releases/latest endpoint still follows OpenCode V1.
const RELEASE_API = 'https://opencode.ai/update/api/latest/cli/npm'
const RELEASES = 'https://github.com/anomalyco/opencode/tree/'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const VERSION = /^\d+\.\d+\.\d+$/
const V2_VERSION = /^2\.\d+\.\d+$/

export interface RuntimeUpdateStatus {
  currentVersion: string
  latestVersion: string
  checkedAt: number
  releaseUrl: string
  updateAvailable: boolean
  checking: boolean
  installing: boolean
  error: string
  source: 'managed' | 'bundled' | 'missing'
}
export interface RuntimeRelease {
  version: string
  releaseUrl: string
  asset: { name: string; url: string; integrity: string }
}
interface ActiveRuntime { version: string; platform: string; arch: string; directory: string }
interface SavedCheck { latestVersion: string; checkedAt: number; releaseUrl: string; error: string }
interface RuntimeOptions {
  home: string
  bundledExecutable?: string
  isBusy?: () => boolean
  beforeActivate?: () => void | Promise<void>
}
interface RuntimeIO {
  release: () => Promise<unknown>
  download: (release: RuntimeRelease, archive: string) => Promise<void>
  extract: (archive: string, directory: string, executable: string) => Promise<void>
  probe: (executable: string) => Promise<string>
  now: () => number
}

function runtimeRoot(home: string) { return path.join(home, 'runtime', 'managed-opencode-v2') }
function executableName(platform = process.platform) { return platform === 'win32' ? 'opencode.exe' : 'opencode' }

export function runtimeAssetName(platform = process.platform, arch = process.arch, musl = false): string {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`OpenCode updates are unavailable for ${platform}/${arch}.`)
  }
  const os = platform === 'win32' ? 'windows' : platform
  // Baseline x64 builds run on CPUs without AVX2 as well as newer processors.
  return `cli-${os}-${arch}${arch === 'x64' ? '-baseline' : ''}${platform === 'linux' && musl ? '-musl' : ''}`
}

function usesMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
  return !report.header?.glibcVersionRuntime
}

export function parseRuntimeRelease(value: unknown, platform = process.platform, arch = process.arch, musl = false): RuntimeRelease {
  if (!value || typeof value !== 'object') throw new Error('Invalid OpenCode release metadata.')
  const data = value as { manifest?: Record<string, any>; package?: Record<string, any> }
  const manifest = data.manifest
  const binary = data.package
  const version = typeof manifest?.version === 'string' ? manifest.version : ''
  if (!V2_VERSION.test(version) || manifest?.channel !== 'latest' || manifest.name !== 'cli' || manifest.distribution !== 'npm' || manifest.active !== true) {
    throw new Error('OpenCode update must be an official stable V2 release.')
  }
  if (manifest.metadata?.package !== '@opencode/cli') throw new Error('Unexpected OpenCode V2 release source.')
  const releaseUrl = RELEASES + 'v' + version
  const name = runtimeAssetName(platform, arch, musl)
  const archive = name + '-' + version + '.tgz'
  const url = `https://registry.npmjs.org/@opencode/${name}/-/${archive}`
  if (binary?.name !== '@opencode/' + name || binary.version !== version || !Array.isArray(binary.os) || !binary.os.includes(platform) || !Array.isArray(binary.cpu) || !binary.cpu.includes(arch)) {
    throw new Error(`This OpenCode package does not match ${platform}/${arch} version ${version}.`)
  }
  if (binary.dist?.tarball !== url || typeof binary.dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(binary.dist.integrity)) {
    throw new Error('OpenCode download URL or npm SHA-512 integrity checksum is invalid.')
  }
  return { version, releaseUrl, asset: { name: archive, url, integrity: binary.dist.integrity } }
}

async function fetchRuntimeRelease(): Promise<unknown> {
  const options = { timeout: 20_000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0,
    headers: { Accept: 'application/json', 'User-Agent': 'DailyWorkMate-OpenCode-V2-Updater' } }
  const manifest = (await axios.get(RELEASE_API, options)).data
  if (!manifest || !V2_VERSION.test(manifest.version) || manifest.metadata?.package !== '@opencode/cli') throw new Error('Invalid official OpenCode V2 update manifest.')
  const name = runtimeAssetName(process.platform, process.arch, usesMusl())
  const binary = (await axios.get(`https://registry.npmjs.org/@opencode%2f${name}/${manifest.version}`, options)).data
  return { manifest, package: binary }
}

export function newerRuntimeVersion(candidate: string, current: string): boolean {
  if (!VERSION.test(candidate)) return false
  if (!VERSION.test(current)) return true
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  return a.some((part, index) => part > b[index] && a.slice(0, index).every((prior, at) => prior === b[at]))
}

function activeRuntime(home: string, file = 'active.json'): ActiveRuntime | undefined {
  try {
    const active = JSON.parse(readFileSync(path.join(runtimeRoot(home), file), 'utf8')) as ActiveRuntime
    if (!V2_VERSION.test(active.version) || active.platform !== process.platform || active.arch !== process.arch ||
      !/^[a-zA-Z0-9.-]+$/.test(active.directory) || active.directory === '.' || active.directory === '..') return undefined
    if (!active.directory.startsWith(`v${active.version}-${active.platform}-${active.arch}-`)) return undefined
    return active
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Companion] Cannot read installed OpenCode runtime:', (error as Error).message)
    return undefined
  }
}

export function managedRuntimeExecutable(home: string): string | undefined {
  const active = activeRuntime(home)
  if (!active) return undefined
  const executable = path.join(runtimeRoot(home), active.directory, executableName())
  return existsSync(executable) ? executable : undefined
}

// Used when the service cannot start a newly installed runtime. No executable
// is deleted; restoring the pointer also works while the old process exits.
export async function rollbackManagedRuntime(home: string): Promise<void> {
  const root = runtimeRoot(home)
  const previous = activeRuntime(home, 'previous.json')
  if (previous && existsSync(path.join(root, previous.directory, executableName()))) {
    await atomicJson(path.join(root, 'active.json'), previous)
  } else {
    await rm(path.join(root, 'active.json'), { force: true })
  }
  await rm(path.join(root, 'previous.json'), { force: true })
}

function run(executable: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, shell: false, timeout, maxBuffer: 64 * 1024,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' },
    }, (error, stdout, stderr) => error ? reject(new Error(`OpenCode runtime validation failed: ${error.message}${stderr ? ': ' + stderr.slice(0, 300) : ''}`)) : resolve(stdout.trim()))
  })
}

async function downloadArchive(release: RuntimeRelease, archive: string): Promise<void> {
  let target = release.asset.url
  const signal = AbortSignal.timeout(10 * 60 * 1000)
  for (let redirect = 0; redirect <= 5; redirect++) {
    const url = new URL(target)
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'registry.npmjs.org') {
      throw new Error('OpenCode download redirected outside the official npm registry.')
    }
    const response = await axios.get(target, { responseType: 'stream', timeout: 30_000, signal, maxRedirects: 0,
      headers: { 'User-Agent': 'DailyWorkMate-OpenCode-Updater' }, validateStatus: status => status === 200 || [301, 302, 303, 307, 308].includes(status) })
    if (response.status !== 200) {
      response.data.destroy()
      if (!response.headers.location) throw new Error('OpenCode download redirect is missing its destination.')
      target = new URL(response.headers.location, target).href
      continue
    }
    let received = 0
    await pipeline(response.data, new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      done(received > MAX_ARCHIVE_BYTES ? new Error('OpenCode archive exceeds the download size limit.') : null, chunk)
    } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    if (!received) throw new Error('OpenCode archive download is empty.')
    return
  }
  throw new Error('Too many OpenCode download redirects.')
}

async function extractArchive(archive: string, directory: string, executable: string): Promise<void> {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : process.platform === 'darwin' ? '/usr/bin/tar' : '/bin/tar'
  const names = (await run(tar, ['-tf', archive])).split(/\r?\n/).filter(Boolean)
  // npm's native package contains only its manifest and package/bin executable.
  // Extract just that expected member, never arbitrary archive paths or links.
  const entry = names.find(name => name === 'package/bin/' + executable)
  if (!entry) throw new Error('The OpenCode archive does not contain the expected executable.')
  await run(tar, ['-xf', archive, '-C', directory, entry], 60_000)
  const extracted = path.join(directory, entry)
  const file = await lstat(extracted)
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 512 * 1024 * 1024) throw new Error('Invalid extracted OpenCode executable.')
  await rename(extracted, path.join(directory, executable))
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

export class OpenCodeRuntimeUpdates {
  private readonly options: RuntimeOptions
  private readonly io: RuntimeIO
  private saved: SavedCheck = { latestVersion: '', checkedAt: 0, releaseUrl: '', error: '' }
  private loaded: Promise<void> | undefined
  private checking: Promise<RuntimeUpdateStatus> | undefined
  private checkedRelease: { release: RuntimeRelease; checkedAt: number } | undefined
  private installing = false
  constructor(options: RuntimeOptions, io: Partial<RuntimeIO> = {}) {
    this.options = options
    this.io = {
      release: fetchRuntimeRelease,
      download: downloadArchive, extract: extractArchive, probe: file => run(file, ['--version']), now: Date.now, ...io,
    }
  }
  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      try {
        const saved = JSON.parse(await readFile(path.join(runtimeRoot(this.options.home), 'updates.json'), 'utf8')) as SavedCheck
        this.saved = { latestVersion: V2_VERSION.test(saved.latestVersion) ? saved.latestVersion : '',
          checkedAt: Number.isFinite(saved.checkedAt) && saved.checkedAt > 0 ? saved.checkedAt : 0,
          releaseUrl: V2_VERSION.test(saved.latestVersion) ? RELEASES + 'v' + saved.latestVersion : '',
          error: typeof saved.error === 'string' ? saved.error.slice(0, 1000) : '' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.saved = { ...this.saved, error: 'Cannot read OpenCode update status: ' + (error as Error).message }
      }
    })()
    return this.loaded
  }
  async status(): Promise<RuntimeUpdateStatus> {
    await this.load()
    const active = managedRuntimeExecutable(this.options.home) ? activeRuntime(this.options.home) : undefined
    const fallback = this.options.bundledExecutable && existsSync(this.options.bundledExecutable) ? this.options.bundledExecutable : path.join(this.options.home, 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    let currentVersion = active?.version || ''
    if (!active && existsSync(fallback)) {
      for (const file of [path.join(path.dirname(fallback), 'runtime-manifest.json'), path.join(this.options.home, 'runtime', 'opencode-v2', 'runtime-manifest.json')]) {
        try {
          const manifest = JSON.parse(await readFile(file, 'utf8'))
          if (VERSION.test(manifest.version)) { currentVersion = manifest.version; break }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Companion] Cannot read bundled OpenCode version:', (error as Error).message)
        }
      }
    }
    return { ...this.saved, currentVersion, source: active ? 'managed' : existsSync(fallback) ? 'bundled' : 'missing',
      updateAvailable: newerRuntimeVersion(this.saved.latestVersion, currentVersion), checking: !!this.checking, installing: this.installing }
  }
  async check(force = false): Promise<RuntimeUpdateStatus> {
    if (this.checking) return this.checking
    await this.load()
    if (this.checking) return this.checking
    if (!force && this.saved.checkedAt > 0 && this.io.now() - this.saved.checkedAt < (this.saved.error ? DAY / 24 : DAY)) return this.status()
    this.checking = (async () => {
      try {
        const release = parseRuntimeRelease(await this.io.release(), process.platform, process.arch, usesMusl())
        this.checkedRelease = { release, checkedAt: this.io.now() }
        this.saved = { latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt: this.io.now(), error: '' }
      } catch (error) {
        this.saved = { ...this.saved, checkedAt: this.io.now(), error: 'OpenCode update check failed: ' + (error as Error).message }
      }
      try { await atomicJson(path.join(runtimeRoot(this.options.home), 'updates.json'), this.saved) }
      catch (error) { this.saved = { ...this.saved, error: 'Cannot save OpenCode update status: ' + (error as Error).message } }
      return { ...await this.status(), checking: false }
    })()
    try { return await this.checking } finally { this.checking = undefined }
  }
  startPeriodicChecks(): () => void {
    void this.check().catch(error => console.warn('[Companion] OpenCode update check failed:', error.message))
    const timer = setInterval(() => { void this.check().catch(error => console.warn('[Companion] OpenCode update check failed:', error.message)) }, 60 * 60 * 1000)
    timer.unref()
    return () => clearInterval(timer)
  }
  async install(): Promise<RuntimeUpdateStatus> {
    if (this.installing) throw new Error('An OpenCode update is already being installed.')
    if (this.options.isBusy?.()) throw new Error('Finish or stop the current workspace task before updating OpenCode.')
    this.installing = true
    let staging = ''
    try {
      await this.load()
      if (this.checking) await this.checking
      // Install the exact release the user just checked. Its npm integrity is
      // already validated, and this avoids a redundant, failure-prone lookup.
      const release = this.checkedRelease && this.io.now() - this.checkedRelease.checkedAt < 10 * 60 * 1000
        ? this.checkedRelease.release : parseRuntimeRelease(await this.io.release(), process.platform, process.arch, usesMusl())
      this.saved = { latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt: this.io.now(), error: '' }
      const current = await this.status()
      if (current.currentVersion && !newerRuntimeVersion(release.version, current.currentVersion)) {
        await atomicJson(path.join(runtimeRoot(this.options.home), 'updates.json'), this.saved)
        return { ...await this.status(), installing: false }
      }
      const root = runtimeRoot(this.options.home)
      staging = path.join(root, '.staging-' + randomUUID())
      await mkdir(staging, { recursive: true })
      const archive = path.join(staging, release.asset.name)
      await this.io.download(release, archive)
      const archiveInfo = await lstat(archive)
      if (!archiveInfo.isFile() || archiveInfo.size <= 0 || archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error('OpenCode archive exceeds the size limit.')
      const digest = createHash('sha512')
      for await (const chunk of createReadStream(archive)) digest.update(chunk)
      if ('sha512-' + digest.digest('base64') !== release.asset.integrity) throw new Error('OpenCode archive SHA-512 verification failed; the current runtime was preserved.')
      const executable = executableName()
      await this.io.extract(archive, staging, executable)
      const extracted = path.join(staging, executable)
      const binaryInfo = await lstat(extracted)
      if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) throw new Error('Invalid OpenCode executable.')
      await chmod(extracted, 0o755)
      const actualVersion = (await this.io.probe(extracted)).trim().replace(/^(?:opencode\s+)?v?/, '')
      if (actualVersion !== release.version) throw new Error('Downloaded OpenCode did not pass the version check; the current runtime was preserved.')
      if (this.options.isBusy?.()) throw new Error('A workspace task started during the download. Finish it, then retry the update.')
      await this.options.beforeActivate?.()
      const directory = `v${release.version}-${process.platform}-${process.arch}-${randomUUID()}`
      await rm(archive)
      await rename(staging, path.join(root, directory))
      staging = ''
      // The running executable is never modified or removed. A failed download,
      // extraction or validation leaves the active pointer and old files intact.
      const previous = activeRuntime(this.options.home)
      if (previous) await atomicJson(path.join(root, 'previous.json'), previous)
      else await rm(path.join(root, 'previous.json'), { force: true })
      await atomicJson(path.join(root, 'active.json'), { version: release.version, platform: process.platform, arch: process.arch, directory } satisfies ActiveRuntime)
      this.saved = { latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt: this.io.now(), error: '' }
      await atomicJson(path.join(root, 'updates.json'), this.saved)
      return { ...await this.status(), installing: false }
    } catch (error) {
      this.saved = { ...this.saved, error: 'OpenCode update failed: ' + (error as Error).message }
      try { await atomicJson(path.join(runtimeRoot(this.options.home), 'updates.json'), this.saved) }
      catch (saveError) { console.warn('[Companion] Cannot save failed OpenCode update status:', (saveError as Error).message) }
      return { ...await this.status(), installing: false }
    } finally {
      this.installing = false
      if (staging && path.dirname(staging) === runtimeRoot(this.options.home) && path.basename(staging).startsWith('.staging-')) await rm(staging, { recursive: true, force: true })
    }
  }
}
