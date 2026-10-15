import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { localSpeechSpeaker, type LocalSpeechStatus } from '../../shared/localSpeech'

type LocalEngine = 'fast' | 'kokoro'
type RequestKind = 'warmup' | 'synthesize' | 'transcribe'
type SpeechResult = Uint8Array | string | true
interface PendingSpeech {
  kind: RequestKind
  engine?: LocalEngine
  resolve: (result: SpeechResult) => void
  reject: (error: Error) => void
  cleanup: () => void
}
interface WarmupOptions { voice: string; language: string; speed: number; engine: LocalEngine }
interface RuntimeState { status: LocalSpeechStatus; identity: string; kokoroAvailable: boolean }
interface CachedAudio { audio: Uint8Array; expires: number }
export interface LocalSpeechOptions {
  runtimeDirectory?: string
  workerPath?: string
  execPath?: string
  timeout?: number
  idleTimeout?: number
  rewarmDelay?: number
  cacheBytes?: number
  cacheEntries?: number
  cacheTtl?: number
}

const missingResources = '本地自然语音资源尚未安装，请安装带语音资源的完整版本。 / Local voice resources are missing. Install the full package with local speech.'
const cancelled = () => new Error('Speech request cancelled')

/** Native inference stays in a killable child; warm models and private audio remain in memory only. */
export class LocalSpeechService {
  private worker: ChildProcess | undefined
  private workerIdentity = ''
  private readyEngine: LocalEngine | undefined
  private requests = new Map<string, PendingSpeech>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private rewarmTimer: ReturnType<typeof setTimeout> | undefined
  private warming: { engine: LocalEngine; promise: Promise<LocalSpeechStatus> } | undefined
  private lastWarmup: WarmupOptions | undefined
  private warmupError: string | undefined
  private disposed = false
  private cancellation = 0
  private cache = new Map<string, CachedAudio>()
  private cacheSize = 0
  private readonly directory: string
  private readonly workerPath: string

  constructor(private readonly options: LocalSpeechOptions = {}) {
    this.directory = options.runtimeDirectory || (app.isPackaged
      ? path.join(process.resourcesPath, 'speech-runtime')
      : path.join(app.getAppPath(), 'companion', 'runtime', 'speech'))
    this.workerPath = options.workerPath || path.join(this.directory, 'local-speech-worker.cjs')
  }

  private modelDirectory(directory: unknown): string {
    if (typeof directory !== 'string' || !directory) throw new Error('Invalid local voice model path')
    const result = path.resolve(this.directory, directory)
    const relative = path.relative(this.directory, result)
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || relative === '..') throw new Error('Invalid local voice model path')
    return result
  }

  private modelFile(directory: string, file: unknown): string {
    if (typeof file !== 'string' || !file || path.basename(file) !== file || file === '.' || file === '..') throw new Error('Invalid local voice manifest')
    return path.join(directory, file)
  }

  private async runtime(): Promise<RuntimeState> {
    const base = { engine: 'sherpa-onnx', model: 'Kokoro v1.1 Chinese / English' }
    try {
      const raw = await fs.readFile(path.join(this.directory, 'runtime-manifest.json'), 'utf8')
      const manifest = JSON.parse(raw)
      if (manifest.engine !== 'sherpa-onnx' || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Local voice runtime does not match this device')
      await Promise.all([this.workerPath, this.options.execPath || path.join(this.directory, 'bin', 'node.exe'), path.join(this.directory, 'node_modules', 'sherpa-onnx-node', 'package.json')].map(file => fs.access(file)))
      const fingerprints: string[] = []
      const checkModel = async (files: string[]) => {
        const stats = await Promise.all(files.map(file => fs.stat(file)))
        fingerprints.push(...stats.map((stat, index) => files[index] + ':' + stat.size + ':' + stat.mtimeMs))
      }
      let kokoroAvailable = false
      let kokoroError = missingResources
      try {
        const directory = this.modelDirectory(manifest.directory)
        await checkModel([this.modelFile(directory, manifest.file), path.join(directory, 'voices.bin')])
        kokoroAvailable = true
      } catch (error) { if (error instanceof Error && !('code' in error)) kokoroError = error.message }
      let fastAvailable = false
      let fastError = '快速本地语音资源尚未安装 / Fast local voice resources are missing'
      try {
        if (!manifest.fast || manifest.fast.family !== 'matcha') throw new Error(fastError)
        const directory = this.modelDirectory(manifest.fast.directory)
        await checkModel([this.modelFile(directory, manifest.fast.file), this.modelFile(directory, manifest.fast.vocoder), path.join(directory, 'tokens.txt'), path.join(directory, 'lexicon.txt'), path.join(directory, 'espeak-ng-data')])
        fastAvailable = true
      } catch (error) { if (error instanceof Error && !('code' in error)) fastError = error.message }
      let recognitionAvailable = false
      if (manifest.recognition) {
        try {
          const directory = this.modelDirectory(manifest.recognition.directory)
          await checkModel([this.modelFile(directory, manifest.recognition.file), path.join(directory, 'tokens.txt')])
          recognitionAvailable = true
        } catch { /* Missing recognition resources are reported independently of synthesis. */ }
      }
      const identity = createHash('sha256').update(raw + '\n' + fingerprints.sort().join('\n')).digest('hex')
      return {
        identity, kokoroAvailable,
        status: {
          ...base, available: kokoroAvailable || fastAvailable, ...(!kokoroAvailable && !fastAvailable ? { error: kokoroError } : {}),
          fastAvailable, fastModel: 'Matcha Chinese / English', ...(!fastAvailable ? { fastError } : {}),
          recognitionAvailable, recognitionModel: 'SenseVoiceSmall', ...(!recognitionAvailable ? { recognitionError: '本地语音识别资源尚未安装 / Local recognition resources are missing' } : {}),
        },
      }
    } catch (error) {
      return { identity: '', kokoroAvailable: false, status: { ...base, available: false, fastAvailable: false, error: error instanceof Error && !('code' in error) ? error.message : missingResources } }
    }
  }

  async status(): Promise<LocalSpeechStatus> {
    const runtime = await this.runtime()
    const ready = !!this.worker && !this.worker.killed && this.workerIdentity === runtime.identity && !!this.readyEngine
    return { ...runtime.status, ready, warming: !!this.warming, ...(ready ? { readyEngine: this.readyEngine } : {}), ...(this.warmupError ? { error: this.warmupError } : {}) }
  }

  async warmup(voice = 'auto', language = 'zh-CN', speed = 1, engine: LocalEngine = 'kokoro'): Promise<LocalSpeechStatus> {
    this.validateOptions(voice, language, speed, engine)
    if (this.disposed) throw new Error('Local speech service is closed')
    this.lastWarmup = { voice, language, speed, engine }
    clearTimeout(this.rewarmTimer)
    if (this.warming) {
      if (this.warming.engine === engine) return this.warming.promise
      await this.warming.promise
      return this.warmup(voice, language, speed, engine)
    }
    const promise = this.performWarmup(voice, language, speed, engine)
    this.warming = { engine, promise }
    try { return await promise }
    finally { if (this.warming?.promise === promise) this.warming = undefined }
  }

  private async performWarmup(voice: string, language: string, speed: number, engine: LocalEngine): Promise<LocalSpeechStatus> {
    try {
      const runtime = await this.runtime()
      this.prepare(runtime, engine)
      this.warmupError = undefined
      if (this.readyEngine !== engine) {
        await this.request({ operation: 'warmup', engine, sid: engine === 'fast' ? 0 : localSpeechSpeaker(voice, language, ''), speed, language }, 'warmup', undefined, engine)
      }
      this.armIdleTimer()
      return { ...runtime.status, ready: true, warming: false, readyEngine: engine }
    } catch (error) {
      this.warmupError = error instanceof Error ? error.message : 'Local speech warmup failed'
      return { ...(await this.status()), warming: false, error: this.warmupError }
    }
  }

  /** Stop user work immediately, without discarding an idle/preloading model. */
  cancel(): void {
    this.cancellation++
    if (![...this.requests.values()].some(request => request.kind !== 'warmup')) return
    this.stop(cancelled())
    this.scheduleWarmup()
  }

  dispose(): void {
    this.disposed = true
    this.cancellation++
    clearTimeout(this.rewarmTimer)
    this.stop(new Error('Local speech service is closed'))
    this.cache.clear()
    this.cacheSize = 0
  }

  private stop(error: Error, expected?: ChildProcess): void {
    if (expected && this.worker !== expected) return
    clearTimeout(this.idleTimer)
    const worker = this.worker
    this.worker = undefined
    this.workerIdentity = ''
    this.readyEngine = undefined
    const requests = [...this.requests.values()]
    this.requests.clear()
    for (const pending of requests) { pending.cleanup(); pending.reject(error) }
    if (worker && !worker.killed) worker.kill()
  }

  private scheduleWarmup(): void {
    clearTimeout(this.rewarmTimer)
    if (this.disposed || !this.lastWarmup) return
    this.rewarmTimer = setTimeout(() => {
      if (this.disposed || !this.lastWarmup || this.requests.size || this.readyEngine) return
      const { voice, language, speed, engine } = this.lastWarmup
      void this.warmup(voice, language, speed, engine).catch(() => { /* The warmup status records model failures; disposal needs no retry. */ })
    }, this.options.rewarmDelay ?? 750)
    this.rewarmTimer.unref()
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer)
    const worker = this.worker
    if (!worker || this.requests.size) return
    this.idleTimer = setTimeout(() => this.stop(new Error('Local voice idle'), worker), this.options.idleTimeout ?? 15 * 60_000)
    this.idleTimer.unref()
  }

  private launch(): ChildProcess {
    if (this.disposed) throw new Error('Local speech service is closed')
    if (this.worker && !this.worker.killed) return this.worker
    const worker = spawn(this.options.execPath || path.join(this.directory, 'bin', 'node.exe'), [this.workerPath], {
      env: { ...process.env },
      cwd: this.directory, windowsHide: true, serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.worker = worker
    worker.on('message', (message: unknown) => {
      if (this.worker !== worker) return
      const reply = message as { id?: unknown; audio?: unknown; text?: unknown; warmed?: unknown; error?: unknown }
      if (typeof reply?.id !== 'string') return
      const pending = this.requests.get(reply.id)
      if (!pending) return
      this.requests.delete(reply.id)
      pending.cleanup()
      if (typeof reply.error === 'string') pending.reject(new Error('本地语音生成失败 / Local speech failed: ' + reply.error.slice(0, 500)))
      else if (pending.kind === 'warmup' && reply.warmed === true) { this.readyEngine = pending.engine; pending.resolve(true) }
      else if (pending.kind === 'transcribe' && typeof reply.text === 'string' && reply.text.length <= 32000) pending.resolve(reply.text)
      else if (pending.kind !== 'synthesize' || !(reply.audio instanceof Uint8Array) || reply.audio.byteLength < 44 || reply.audio.byteLength > 10 * 1024 * 1024) pending.reject(new Error('Local voice returned invalid audio'))
      else { this.readyEngine = pending.engine; this.warmupError = undefined; pending.resolve(new Uint8Array(reply.audio)) }
      this.armIdleTimer()
    })
    worker.once('error', () => this.stop(new Error('本地语音进程无法启动 / Cannot start local speech worker'), worker))
    worker.once('exit', code => this.stop(new Error('本地语音进程已退出 / Local speech worker exited (' + code + ')'), worker))
    return worker
  }

  private validateOptions(voice: string, language: string, speed: number, engine: LocalEngine): void {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Speech rate must be 0.5–2')
    if (engine !== 'fast' && engine !== 'kokoro') throw new Error('Unknown local speech engine')
    localSpeechSpeaker(voice, language, '')
  }

  private prepare(runtime: RuntimeState, engine?: LocalEngine): void {
    if (this.disposed) throw new Error('Local speech service is closed')
    if (engine === 'fast' && !runtime.status.fastAvailable) throw new Error(runtime.status.fastError || runtime.status.error)
    if (engine === 'kokoro' && !runtime.kokoroAvailable) throw new Error(runtime.status.error || missingResources)
    if (this.workerIdentity && this.workerIdentity !== runtime.identity) this.stop(new Error('Local speech resources changed'))
    this.workerIdentity = runtime.identity
  }

  private cached(key: string): Uint8Array | undefined {
    const now = Date.now()
    for (const [entryKey, value] of this.cache) {
      if (value.expires <= now) { this.cache.delete(entryKey); this.cacheSize -= value.audio.byteLength }
    }
    const result = this.cache.get(key)
    if (!result) return
    this.cache.delete(key)
    this.cache.set(key, result)
    this.armIdleTimer()
    return new Uint8Array(result.audio)
  }

  private remember(key: string, audio: Uint8Array): void {
    const limit = this.options.cacheBytes ?? 16 * 1024 * 1024
    const entries = this.options.cacheEntries ?? 32
    if (audio.byteLength > limit || entries < 1 || this.disposed) return
    const previous = this.cache.get(key)
    if (previous) { this.cache.delete(key); this.cacheSize -= previous.audio.byteLength }
    while (this.cache.size && (this.cacheSize + audio.byteLength > limit || this.cache.size >= entries)) {
      const [oldest, value] = this.cache.entries().next().value!
      this.cache.delete(oldest)
      this.cacheSize -= value.audio.byteLength
    }
    this.cache.set(key, { audio: new Uint8Array(audio), expires: Date.now() + (this.options.cacheTtl ?? 15 * 60_000) })
    this.cacheSize += audio.byteLength
  }

  async synthesize(text: string, voice: string, language: string, speed: number, signal?: AbortSignal, engine: LocalEngine = 'kokoro'): Promise<{ audio: Uint8Array; mime: string }> {
    const generation = this.cancellation
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || text.includes('\0')) throw new Error('Local speech text must contain 1–2000 characters')
    this.validateOptions(voice, language, speed, engine)
    const sid = engine === 'fast' ? 0 : localSpeechSpeaker(voice, language, text)
    const runtime = await this.runtime()
    if (signal?.aborted || generation !== this.cancellation) throw cancelled()
    this.prepare(runtime, engine)
    this.lastWarmup = { voice, language, speed, engine }
    const key = createHash('sha256').update(JSON.stringify([runtime.identity, engine, voice, sid, speed, text])).digest('hex')
    const cached = this.cached(key)
    if (cached) return { audio: cached, mime: 'audio/wav' }
    const audio = await this.request({ text, sid, speed, engine }, 'synthesize', signal, engine)
    if (signal?.aborted || generation !== this.cancellation) throw cancelled()
    if (!(audio instanceof Uint8Array)) throw new Error('Local voice returned invalid audio')
    this.remember(key, audio)
    return { audio, mime: 'audio/wav' }
  }

  async transcribe(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const generation = this.cancellation
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 46 || bytes.byteLength > 7 * 1024 * 1024) throw new Error('Invalid local recording')
    const runtime = await this.runtime()
    if (signal?.aborted || generation !== this.cancellation) throw cancelled()
    if (!runtime.status.recognitionAvailable) throw new Error(runtime.status.recognitionError || runtime.status.error)
    this.prepare(runtime)
    const result = await this.request({ operation: 'transcribe', audio: bytes }, 'transcribe', signal)
    if (typeof result !== 'string') throw new Error('Local recognition returned invalid text')
    return result
  }

  private async request(payload: Record<string, unknown>, kind: RequestKind, signal?: AbortSignal, engine?: LocalEngine): Promise<SpeechResult> {
    if (signal?.aborted) throw cancelled()
    clearTimeout(this.idleTimer)
    clearTimeout(this.rewarmTimer)
    const worker = this.launch()
    const id = randomUUID()
    return new Promise<SpeechResult>((resolve, reject) => {
      const abort = () => { this.stop(cancelled(), worker); this.scheduleWarmup() }
      const timer = setTimeout(() => this.stop(new Error('本地语音生成超时 / Local speech generation timed out'), worker), this.options.timeout ?? 90_000)
      this.requests.set(id, { kind, engine, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      worker.send({ id, ...payload }, error => { if (error) this.stop(new Error('Local speech worker disconnected'), worker) })
    })
  }
}
