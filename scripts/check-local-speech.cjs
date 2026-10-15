// Offline native synthesis with the same bundled Node child used by the app.
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const directory = path.resolve(process.argv.find(item => item.startsWith('--runtime='))?.slice(10) || 'companion/runtime/speech')
const output = path.resolve('tmp/qa/local-speech')
fs.mkdirSync(output, { recursive: true })
const executable = path.join(directory, 'bin', 'node.exe')
const worker = fork(path.join(directory, 'local-speech-worker.cjs'), [], {
  execPath: executable, cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
})
let stderr = ''
worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
let current
worker.on('message', value => current?.(value))
worker.on('error', error => finish(error))
worker.on('exit', code => { if (code && !finished) finish(new Error('Worker exited ' + code + ': ' + stderr)) })
let finished = false
const report = []
const timer = setTimeout(() => finish(new Error('Local speech timed out: ' + stderr)), 180_000)
function finish(error) {
  if (finished) return
  finished = true; clearTimeout(timer); worker.kill()
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: !error, engine: 'Kokoro v1.1 int8 / sherpa-onnx 1.13.8', offline: true, results: report, error: error?.message }, null, 2))
  console.log(JSON.stringify({ passed: !error, results: report, error: error?.message }))
  process.exitCode = error ? 1 : 0
}
function generate(id, text, sid, speed) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    current = value => {
      if (value.id !== id) return
      if (value.error) return reject(new Error(value.error))
      try {
        const buffer = Buffer.from(value.audio)
        assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
        assert.equal(buffer.toString('ascii', 8, 12), 'WAVE')
        const rate = buffer.readUInt32LE(24), count = (buffer.length - 44) / 2
        let energy = 0, maximum = 0
        for (let i = 0; i < count; i++) { const sample = buffer.readInt16LE(44 + i * 2) / 32768; energy += sample * sample; maximum = Math.max(maximum, Math.abs(sample)) }
        const rms = Math.sqrt(energy / count)
        assert.ok(rms > 0.005 && maximum > 0.05, 'Audio must contain a non-silent speech waveform')
        assert.ok(count / rate > 1)
        fs.writeFileSync(path.join(output, id + '.wav'), buffer)
        const result = { id, sid, speed, inputCharacters: text.length, sampleRate: rate, durationSeconds: count / rate, generationMs: Date.now() - start, rms, bytes: buffer.length }
        report.push(result); console.log(JSON.stringify(result)); resolve(result)
      } catch (error) { reject(error) }
    }
    worker.send({ id, text, sid, speed })
  })
}
function recognize(id, expected) {
  const began = Date.now()
  return new Promise((resolve, reject) => {
    current = value => {
      if (value.id !== 'asr-' + id) return
      if (value.error) return reject(new Error(value.error))
      try {
        assert.match(value.text, expected)
        const result = { id: 'asr-' + id, transcription: value.text, recognitionMs: Date.now() - began }
        report.push(result); console.log(JSON.stringify(result)); resolve()
      } catch (error) { reject(error) }
    }
    worker.send({ id: 'asr-' + id, operation: 'transcribe', audio: fs.readFileSync(path.join(output, id + '.wav')) })
  })
}
async function main() {
  const text = '你好，我是小伴，一只可爱的粉红色章鱼。今天我们一起整理工作，也可以慢慢聊聊。'
  const normal = await generate('chinese-normal', text, 3, 1)
  const fast = await generate('chinese-fast', text, 3, 1.4)
  assert.ok(fast.durationSeconds < normal.durationSeconds * 0.9, 'Speaking-rate control must change generated audio duration')
  await generate('english', 'Hello, I am your little pink octopus. Let us organize the workspace together, one step at a time.', 0, 1)
  await recognize('chinese-normal', /粉红色章鱼/)
  await recognize('english', /pink octopus/i)
}
main().then(() => finish(), finish)
