// Project-local, pinned CPU speech runtime. No global Python, CUDA or registry changes.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const VERSION = '1.13.8'
const MODEL = 'kokoro-int8-multi-lang-v1_1'
const MODEL_SHA256 = 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL}.tar.bz2`
const NODE_VERSION = '22.22.0'
const NODE_SHA256 = 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'
const root = path.resolve(__dirname, '..', 'companion', 'runtime', 'speech')
const models = path.join(root, 'models')
const archive = path.join(root, MODEL + '.tar.bz2')
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64', 'win-ia32']
const native = 'sherpa-onnx-' + (process.platform === 'win32' ? 'win' : process.platform) + '-' + process.arch
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(path.basename(file) + ' exited ' + code)))
})
async function hash(file) {
  const result = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) result.update(chunk)
  return result.digest('hex')
}
async function installModel() {
  await fsp.mkdir(models, { recursive: true })
  const existing = path.join(models, MODEL, 'model.int8.onnx')
  if (fs.existsSync(existing) && await hash(existing) === 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26') {
    return { directory: 'models/' + MODEL, file: 'model.int8.onnx', sha256: await hash(existing) }
  }
  if (!fs.existsSync(archive) || await hash(archive) !== MODEL_SHA256) {
    console.log('[Speech] Downloading official Kokoro Chinese/English int8 model (147 MB)...')
    const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!response.ok || !response.body) throw new Error('Model download failed: HTTP ' + response.status)
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive))
  }
  if (await hash(archive) !== MODEL_SHA256) throw new Error('Kokoro model archive checksum mismatch')
  const listing = spawnSync('tar', ['-tjf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
  if (listing.error || listing.status !== 0) throw new Error('Cannot inspect model archive with tar')
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (!entries.length || entries.some(entry => !entry.startsWith(MODEL + '/') || path.isAbsolute(entry) || /(^|[\\/])\.\.([\\/]|$)/.test(entry))) {
    throw new Error('Model archive contains an unsafe path')
  }
  const details = spawnSync('tar', ['-tvjf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
  if (details.error || details.status !== 0 || details.stdout.split(/\r?\n/).filter(Boolean).some(line => !/^[d-]/.test(line))) {
    throw new Error('Model archive contains unsupported links or file types')
  }
  await run('tar', ['-xjf', archive, '-C', models])
  const directory = path.join(models, MODEL)
  const onnx = ['model.int8.onnx', 'model.onnx'].find(name => fs.existsSync(path.join(directory, name)))
  if (!onnx) throw new Error('Extracted Kokoro model is missing')
  for (const file of ['voices.bin', 'tokens.txt', 'lexicon-zh.txt', 'lexicon-us-en.txt', 'LICENSE']) {
    if (!fs.existsSync(path.join(directory, file))) throw new Error('Model resource missing: ' + file)
  }
  await fsp.rm(archive)
  return { directory: 'models/' + MODEL, file: onnx, sha256: await hash(path.join(directory, onnx)) }
}
async function installNode() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The packaged local speech helper currently supports Windows x64')
  const bin = path.join(root, 'bin')
  await fsp.mkdir(bin, { recursive: true })
  const executable = path.join(bin, 'node.exe')
  if (fs.existsSync(executable)) {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (version.status === 0 && version.stdout.trim() === 'v' + NODE_VERSION) return
  }
  const prefix = `node-v${NODE_VERSION}-win-x64`
  const zip = path.join(root, prefix + '.zip')
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${prefix}.zip`, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!response.ok || !response.body) throw new Error('Node helper download failed: HTTP ' + response.status)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip))
  if (await hash(zip) !== NODE_SHA256) throw new Error('Node helper checksum mismatch')
  await run('tar', ['-xf', zip, '-C', root, prefix + '/node.exe', prefix + '/LICENSE'])
  await fsp.copyFile(path.join(root, prefix, 'node.exe'), executable)
  await fsp.copyFile(path.join(root, prefix, 'LICENSE'), path.join(bin, 'NODE-LICENSE.txt'))
  const temporary = path.resolve(root, prefix)
  if (!temporary.startsWith(root + path.sep) || temporary === root) throw new Error('Unsafe cleanup path')
  await fsp.rm(temporary, { recursive: true })
  await fsp.rm(zip)
}
async function main() {
  if (!platforms.includes(native.replace('sherpa-onnx-', ''))) throw new Error('No bundled local speech runtime for this platform')
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run npm run companion:speech:setup')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true, dependencies: { 'sherpa-onnx-node': VERSION },
    overrides: Object.fromEntries(platforms.map(platform => ['sherpa-onnx-' + platform, VERSION])),
  }, null, 2) + '\n')
  const [, model, , recognition, , fast] = await Promise.all([
    run(process.execPath, [npmCli, 'install', '--prefix', root, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']),
    installModel(),
    installNode(),
    require('./setup-local-stt.cjs')(root),
    require('./setup-speech-licenses.cjs')(root),
    require('./setup-fast-speech.cjs')(root),
  ])
  const loaded = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(path.join(root, 'node_modules', 'sherpa-onnx-node'))});if(typeof m.OfflineTts!=='function')process.exit(1)`], {
    windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  if (loaded.error || loaded.status !== 0) throw new Error('Native speech runtime could not load: ' + (loaded.error?.message || loaded.stderr.slice(-2000)))
  await fsp.copyFile(path.join(__dirname, 'local-speech-worker.cjs'), path.join(root, 'local-speech-worker.cjs'))
  await fsp.writeFile(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    version: VERSION, engine: 'sherpa-onnx', package: 'sherpa-onnx-node', platform: process.platform, arch: process.arch,
    nodeVersion: NODE_VERSION, nodeArchiveSha256: NODE_SHA256,
    model: 'Kokoro v1.1 Chinese / English', ...model, archiveSha256: MODEL_SHA256,
    recognition,
    fast,
    sources: [MODEL_URL, 'https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh', 'https://github.com/k2-fsa/sherpa-onnx'],
    licenses: ['Apache-2.0 (Kokoro and sherpa-onnx)', 'GPL-3.0 (eSpeak NG text frontend; see bundled notices)'],
  }, null, 2) + '\n')
  console.log('[Speech] Local CPU speech runtime and model ready: ' + root)
}
main().catch(error => { console.error('[Speech]', error.message); process.exitCode = 1 })
