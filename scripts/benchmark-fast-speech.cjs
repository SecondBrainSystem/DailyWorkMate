// Real CPU synthesis benchmark. Each engine starts in a fresh bundled Node process.
const fs = require('node:fs')
const path = require('node:path')
const { fork } = require('node:child_process')
const runtime = path.resolve('companion/runtime/speech')
const output = path.resolve('tmp/qa/fast-speech')
const shortText = '你好，我是你的小伴章鱼。'
const longText = '你好，我是小伴，一只可爱的粉红色章鱼。今天我们一起整理工作，也可以慢慢聊聊。'

function child(engine, threads) {
  const started = Date.now()
  const sherpa = require(path.join(runtime, 'node_modules/sherpa-onnx-node'))
  const natural = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'))
  const fast = JSON.parse(fs.readFileSync(path.join(runtime, 'fast-runtime-manifest.json'), 'utf8'))
  const selected = engine === 'fast' ? fast : natural
  const model = path.join(runtime, selected.directory)
  const family = engine === 'fast' ? {
    matcha: { acousticModel: path.join(model, selected.file), vocoder: path.join(model, selected.vocoder),
      tokens: path.join(model, 'tokens.txt'), dataDir: path.join(model, 'espeak-ng-data'), lexicon: path.join(model, 'lexicon.txt') },
  } : {
    kokoro: { model: path.join(model, selected.file), voices: path.join(model, 'voices.bin'), tokens: path.join(model, 'tokens.txt'),
      dataDir: path.join(model, 'espeak-ng-data'), dictDir: path.join(model, 'dict'),
      lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt'].map(file => path.join(model, file)).join(',') },
  }
  const tts = new sherpa.OfflineTts({ model: { ...family, provider: 'cpu', numThreads: threads, debug: false }, maxNumSentences: 1,
    ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'].map(file => path.join(model, file)).filter(file => fs.existsSync(file)).join(','),
  })
  const initializeMs = Date.now() - started
  const cases = [
    ['short-cold', shortText, 1], ['short-warm-1', shortText, 1], ['short-warm-2', shortText, 1],
    ['long-warm', longText, 1], ['long-fast-rate', longText, 1.4],
  ]
  if (engine === 'fast') cases.push(
    ['mixed', '你好，今天我们一起学习 artificial intelligence。Hello, I am your little pink octopus.', 1],
    ['product-date', '今天是2026年10月8日。请用OpenCode整理三个文件，共计128元。', 1],
  )
  for (const [id, text, speed] of cases) {
    const began = Date.now()
    const audio = tts.generate({ text, generationConfig: new sherpa.GenerationConfig({ sid: engine === 'fast' ? 0 : 3, speed, silenceScale: 0.2 }) })
    const synthesisMs = Date.now() - began
    if (!(audio.samples instanceof Float32Array) || !audio.samples.length) throw new Error('No speech was generated')
    const rms = Math.sqrt(audio.samples.reduce((sum, value) => sum + value * value, 0) / audio.samples.length)
    if (rms < 0.005) throw new Error('Generated speech is silent')
    const file = engine + '-' + threads + '-' + id + '.wav'
    sherpa.writeWave(path.join(output, file), audio)
    process.send({ engine, threads, id, text, characters: text.length, speed, initializeMs, synthesisMs,
      durationSeconds: audio.samples.length / audio.sampleRate, sampleRate: audio.sampleRate, rms, file })
  }
  if (engine === 'fast') {
    const directory = path.join(runtime, natural.recognition.directory)
    const recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
      senseVoice: { model: path.join(directory, natural.recognition.file), useInverseTextNormalization: 1 },
      tokens: path.join(directory, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: false,
    } })
    for (const id of ['short-cold', 'long-warm', 'mixed', 'product-date']) {
      const audio = sherpa.readWave(path.join(output, engine + '-' + threads + '-' + id + '.wav'))
      const stream = recognizer.createStream(); stream.acceptWaveform(audio); recognizer.decode(stream)
      process.send({ engine, threads, id: 'recognize-' + id, text: recognizer.getResult(stream).text.replace(/<\|[^|]+\|>/g, '').trim() })
    }
  }
  process.disconnect()
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const results = []
  const selection = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9)
  const threads = Number(process.argv.find(arg => arg.startsWith('--threads='))?.slice(10) || 4)
  if (![1, 2, 4, 8].includes(threads)) throw new Error('Choose 1, 2, 4 or 8 threads')
  for (const engine of selection ? [selection] : ['fast', 'kokoro']) {
    if (!['fast', 'kokoro'].includes(engine)) throw new Error('Choose fast or kokoro')
    const began = Date.now()
    await new Promise((resolve, reject) => {
      const process = fork(__filename, ['--child', engine, String(threads)], {
        execPath: path.join(runtime, 'bin', 'node.exe'), cwd: path.resolve('.'), windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      let stderr = ''
      process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
      const timer = setTimeout(() => { process.kill(); reject(new Error('Benchmark timed out: ' + stderr)) }, 180_000)
      process.on('message', message => {
        const record = { ...message, ...(message.id === 'short-cold' ? { firstPlayableMs: Date.now() - began } : {}) }
        results.push(record); console.log(JSON.stringify(record))
      })
      process.once('error', reject)
      process.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Benchmark failed (' + code + '): ' + stderr)) })
    })
  }
  const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, provider: 'cpu', runtime, results }
  fs.writeFileSync(path.join(output, `benchmark-${selection || 'comparison'}-${threads}.json`), JSON.stringify(report, null, 2))
  console.log('Evidence: ' + path.join(output, `benchmark-${selection || 'comparison'}-${threads}.json`))
}
if (process.argv[2] === '--child') {
  try { child(process.argv[3], Number(process.argv[4])) } catch (error) { console.error(error); process.exit(1) }
} else main().catch(error => { console.error(error); process.exitCode = 1 })
