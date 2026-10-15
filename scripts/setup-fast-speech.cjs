// Adds one verified CPU neural TTS candidate without replacing Kokoro resources.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const NAME = 'matcha-icefall-zh-en'
const ARCHIVE_SHA = '271b804af570400d3bcdcb53bf6e53cc9f75180ee763b9f13eb5eaf2b0d086ef'
const VOCODER_SHA = 'b599142a1fb8ff03de3e84ac35ff537c619e56f4267a6fe894851a42844acf9e'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${NAME}.tar.bz2`
const VOCODER_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-16khz-univ.onnx'
const SOURCE = 'https://modelscope.cn/models/dengcunqin/matcha_tts_zh_en_20251010'
async function hash(file) { const digest = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest('hex') }
async function download(url, destination, checksum) {
  if (fs.existsSync(destination) && await hash(destination) === checksum) return
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error('Fast voice download failed: HTTP ' + response.status)
  const temporary = destination + '.part'
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary))
  if (await hash(temporary) !== checksum) throw new Error('Fast voice download checksum mismatch')
  await fsp.rename(temporary, destination)
}
async function install(root = path.resolve(__dirname, '..', 'companion', 'runtime', 'speech')) {
  const directory = path.join(root, 'models', NAME)
  await fsp.mkdir(directory, { recursive: true })
  const marker = path.join(root, 'fast-runtime-manifest.json')
  let saved
  try { saved = JSON.parse(await fsp.readFile(marker, 'utf8')) } catch { /* first installation */ }
  const file = path.join(directory, 'model-steps-3.onnx')
  if (!saved || saved.archiveSha256 !== ARCHIVE_SHA || !fs.existsSync(file) || saved.sha256 !== await hash(file)) {
    const archive = path.join(root, NAME + '.tar.bz2')
    console.log('[Speech] Downloading official Matcha Chinese/English acoustic model (79 MB)...')
    await download(MODEL_URL, archive, ARCHIVE_SHA)
    const options = { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
    const listing = spawnSync('tar', ['-tjf', archive], options)
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
    if (listing.status !== 0 || !entries.length || entries.some(entry => !entry.startsWith(NAME + '/') || path.isAbsolute(entry) || /(^|[\\/])\.\.([\\/]|$)/.test(entry))) throw new Error('Unsafe fast voice archive path')
    const details = spawnSync('tar', ['-tvjf', archive], options)
    if (details.status !== 0 || details.stdout.split(/\r?\n/).filter(Boolean).some(line => !/^[d-]/.test(line))) throw new Error('Fast voice archive contains unsupported links')
    const result = spawnSync('tar', ['-xjf', archive, '-C', path.join(root, 'models')], { windowsHide: true })
    if (result.status !== 0) throw new Error('Fast voice extraction failed')
    await fsp.rm(archive)
  }
  await download(VOCODER_URL, path.join(directory, 'vocos-16khz-univ.onnx'), VOCODER_SHA)
  for (const relative of ['model-steps-3.onnx', 'tokens.txt', 'lexicon.txt', 'espeak-ng-data', 'README.md']) await fsp.access(path.join(directory, relative))
  const metadataResponse = await fetch('https://modelscope.cn/api/v1/models/dengcunqin/matcha_tts_zh_en_20251010', { signal: AbortSignal.timeout(30000) })
  if (!metadataResponse.ok) throw new Error('Cannot verify original fast voice license')
  const metadata = (await metadataResponse.json()).Data
  if (metadata?.License !== 'Apache License 2.0') throw new Error('Original fast voice license changed; review before installing')
  const licenseResponse = await fetch('https://www.apache.org/licenses/LICENSE-2.0.txt', { signal: AbortSignal.timeout(30000) })
  if (!licenseResponse.ok) throw new Error('Cannot obtain fast voice Apache license')
  await fsp.writeFile(path.join(directory, 'LICENSE'), await licenseResponse.text())
  await fsp.writeFile(path.join(directory, 'MODEL-NOTICE.txt'), `Matcha Chinese / English neural TTS (matcha_tts_zh_en_20251010)\nAuthor: dengcunqin\nOriginal model and vocoder: ${SOURCE}\nLicense: Apache License 2.0 (as declared by the original author on ModelScope)\nConversion and distribution: https://github.com/k2-fsa/sherpa-onnx\nOfficial usage: https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/matcha-icefall-zh-en.html\n\nThis is the author's Chinese/English model, not the separate non-commercial Baker model.\nThe espeak-ng-data text frontend is covered by the bundled eSpeak NG GPL-3.0 notice in ../../licenses.\n`)
  await fsp.writeFile(path.join(directory, 'source-license.json'), JSON.stringify({ source: SOURCE, name: metadata.Name, author: metadata.CreatedBy, license: metadata.License, revision: metadata.Revision, checkedAt: new Date().toISOString() }, null, 2))
  const manifest = { family: 'matcha', directory: 'models/' + NAME, file: 'model-steps-3.onnx', vocoder: 'vocos-16khz-univ.onnx', model: 'Matcha Chinese / English', sampleRate: 16000, speakers: 1, language: 'zh-en', license: 'Apache-2.0', source: SOURCE, sha256: await hash(file), archiveSha256: ARCHIVE_SHA, vocoderSha256: VOCODER_SHA }
  await fsp.writeFile(marker, JSON.stringify(manifest, null, 2) + '\n')
  console.log('[Speech] Fast local voice ready: ' + directory)
  return manifest
}
module.exports = install
if (require.main === module) install().catch(error => { console.error('[Speech]', error.message); process.exitCode = 1 })
