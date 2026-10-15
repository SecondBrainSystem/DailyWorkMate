const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const SHA = '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`
async function hash(file) { const digest = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest('hex') }
module.exports = async root => {
  const directory = path.join(root, 'models', NAME)
  const model = path.join(directory, 'model.int8.onnx')
  const marker = path.join(directory, 'verified-model.json')
  if (fs.existsSync(model) && fs.existsSync(marker)) {
    const saved = JSON.parse(await fsp.readFile(marker, 'utf8'))
    if (saved.archiveSha256 === SHA && await hash(model) === saved.sha256) return { directory: 'models/' + NAME, file: 'model.int8.onnx', ...saved }
  }
  const archive = path.join(root, NAME + '.tar.bz2')
  console.log('[Speech] Installing official offline SenseVoice model (163 MB)...')
  const response = await fetch(URL, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error('SenseVoice download failed: HTTP ' + response.status)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive))
  if (await hash(archive) !== SHA) throw new Error('SenseVoice checksum mismatch')
  const listing = spawnSync('tar', ['-tjf', archive], { encoding: 'utf8', windowsHide: true })
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (listing.status !== 0 || !entries.length || entries.some(entry => !entry.startsWith(NAME + '/') || path.isAbsolute(entry) || /(^|[\\/])\.\.([\\/]|$)/.test(entry))) throw new Error('Unsafe SenseVoice archive')
  const details = spawnSync('tar', ['-tvjf', archive], { encoding: 'utf8', windowsHide: true })
  if (details.status !== 0 || details.stdout.split(/\r?\n/).filter(Boolean).some(line => !/^[d-]/.test(line))) throw new Error('Unsupported SenseVoice archive links')
  await fsp.mkdir(path.join(root, 'models'), { recursive: true })
  const extracted = spawnSync('tar', ['-xjf', archive, '-C', path.join(root, 'models')], { windowsHide: true })
  if (extracted.status !== 0 || !fs.existsSync(model) || !fs.existsSync(path.join(directory, 'tokens.txt'))) throw new Error('SenseVoice extraction failed')
  const result = { archiveSha256: SHA, sha256: await hash(model), source: URL, model: 'SenseVoiceSmall (Alibaba / FunAudioLLM)', license: 'FunASR Model License 1.1' }
  await fsp.writeFile(marker, JSON.stringify(result, null, 2))
  await fsp.rm(archive)
  return { directory: 'models/' + NAME, file: 'model.int8.onnx', ...result }
}
