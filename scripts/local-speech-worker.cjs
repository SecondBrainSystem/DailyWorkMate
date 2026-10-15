// Loaded in a dedicated Electron/Node child, never on the Electron UI thread.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const root = __dirname
const threads = [1, 2, 4, 8].includes(Number(process.env.DAILYWORKMATE_SPEECH_THREADS)) ? Number(process.env.DAILYWORKMATE_SPEECH_THREADS) : Math.max(1, Math.min(4, os.availableParallelism?.() || os.cpus().length))
let tts
let ttsEngine
let recognizer
function recognize(bytes) {
  const buffer = Buffer.from(bytes)
  // The renderer sends a canonical PCM16 mono WAV, so no codec, temp file or network is needed.
  if (buffer.length < 46 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 16) !== 'WAVEfmt '
    || buffer.readUInt32LE(16) !== 16 || buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(22) !== 1
    || buffer.readUInt16LE(34) !== 16 || buffer.toString('ascii', 36, 40) !== 'data') throw new Error('Local recognition requires PCM16 mono WAV')
  const sampleRate = buffer.readUInt32LE(24)
  const length = buffer.readUInt32LE(40)
  if (sampleRate < 8000 || sampleRate > 96000 || length % 2 || length + 44 !== buffer.length || length / 2 / sampleRate > 35) throw new Error('Recording must be at most 35 seconds')
  const samples = new Float32Array(length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(44 + i * 2) / 32768
  if (!recognizer) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'))
    if (!manifest.recognition) throw new Error('Local recognition resources are missing')
    const model = path.join(root, manifest.recognition.directory)
    const sherpa = require(path.join(root, 'node_modules', 'sherpa-onnx-node'))
    recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
      senseVoice: { model: path.join(model, manifest.recognition.file), useInverseTextNormalization: 1 },
      tokens: path.join(model, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: false,
    } })
  }
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate, samples })
  recognizer.decode(stream)
  return recognizer.getResult(stream).text.replace(/<\|[^|]+\|>/g, '').trim()
}
function createTts(engine) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'))
  const fast = engine === 'fast'
  if (fast && manifest.fast?.family !== 'matcha') throw new Error('Fast local voice resources are missing')
  const selected = fast ? manifest.fast : manifest
  const model = path.join(root, selected.directory)
  const sherpa = require(path.join(root, 'node_modules', 'sherpa-onnx-node'))
  const configuration = fast ? { matcha: {
    acousticModel: path.join(model, selected.file), vocoder: path.join(model, selected.vocoder),
    tokens: path.join(model, 'tokens.txt'), dataDir: path.join(model, 'espeak-ng-data'), lexicon: path.join(model, 'lexicon.txt'),
  } } : { kokoro: {
    model: path.join(model, selected.file), voices: path.join(model, 'voices.bin'), tokens: path.join(model, 'tokens.txt'),
    dataDir: path.join(model, 'espeak-ng-data'), dictDir: path.join(model, 'dict'),
    lexicon: [path.join(model, 'lexicon-us-en.txt'), path.join(model, 'lexicon-zh.txt')].join(','),
  } }
  return { sherpa, engine: new sherpa.OfflineTts({
    model: { ...configuration, provider: 'cpu', numThreads: threads, debug: false },
    maxNumSentences: 1,
    ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'].map(name => path.join(model, name)).filter(file => fs.existsSync(file)).join(','),
  }) }
}
function wave(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > 24_000 * 180 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid local speech audio')
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return bytes
}
process.on('message', message => {
  const id = message?.id
  try {
    if (typeof id === 'string' && message.operation === 'transcribe') {
      if (!(message.audio instanceof Uint8Array) || message.audio.byteLength > 7 * 1024 * 1024) throw new Error('Invalid local recording')
      process.send?.({ id, text: recognize(message.audio) })
      return
    }
    const engine = message.engine || 'kokoro'
    const warming = message.operation === 'warmup'
    const text = warming ? (String(message.language).startsWith('zh') ? '你好。' : 'Hello.') : message.text
    if (typeof id !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 2000 || text.includes('\0')
      || !Number.isInteger(message.sid) || message.sid < 0 || message.sid > 102
      || !Number.isFinite(message.speed) || message.speed < 0.5 || message.speed > 2
      || !['fast', 'kokoro'].includes(engine) || (engine === 'fast' && message.sid !== 0)) throw new Error('Invalid local speech request')
    if (!tts || ttsEngine !== engine) { tts = createTts(engine); ttsEngine = engine }
    const audio = tts.engine.generate({ text, generationConfig: new tts.sherpa.GenerationConfig({ sid: message.sid, speed: message.speed, silenceScale: 0.2 }) })
    if (warming) { process.send?.({ id, warmed: true }); return }
    process.send?.({ id, audio: wave(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate })
  } catch (error) {
    process.send?.({ id, error: error instanceof Error ? error.message : 'Local speech failed' })
  }
})
process.on('disconnect', () => process.exit())
process.send?.({ ready: true })
