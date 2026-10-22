// Explicit live smoke check: sends only a fixed, nonsensitive prompt to a free model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp', 'qa', 'kilo-live-' + Date.now())
fs.mkdirSync(output, { recursive: true })
buildSync({ stdin: { contents: "export { kiloFreeModels } from './src/main/inference/kiloModels.ts'; export { forwardKiloCompletion } from './src/main/inference/kiloTransport.ts'", resolveDir: root },
  outfile: path.join(output, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { kiloFreeModels, forwardKiloCompletion } = require(path.join(output, 'service.cjs'))
;(async () => {
  const catalogue = await kiloFreeModels.get(true)
  assert.equal(catalogue.stale, false, catalogue.error)
  const model = catalogue.models.find(model => model.apiModel === 'cohere/north-mini-code:free')
    || catalogue.models.find(model => model.apiModel === 'kilo-auto/free')
  assert.ok(model, 'No smoke-test model in the current free catalogue')
  const results = []
  for (const stream of [false, true]) {
    const result = await forwardKiloCompletion({ model: model.id, messages: [{ role: 'user', content: 'Reply with only OK.' }], max_tokens: 128, stream }, AbortSignal.timeout(45_000), 30_000)
    assert.equal(result.success, true, result.error)
    if (stream) {
      let body = ''; for await (const chunk of result.stream) body += chunk.toString()
      assert.match(body, /\[DONE\]/)
      const packets = body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      const answer = packets.map(packet => packet.choices?.[0]?.delta?.content || '').join('')
      assert.ok(answer.trim(), 'Empty stream answer')
      results.push({ stream, answer, usage: packets.findLast(packet => packet.usage)?.usage })
    } else {
      const answer = result.body.choices[0].message.content
      assert.ok(answer.trim(), 'Empty non-stream answer')
      results.push({ stream, answer, usage: result.body.usage })
    }
  }
  const report = { passed: true, freeModelCount: catalogue.models.length, model: model.id, results }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence: path.join(output, 'report.json') }))
})().catch(error => { console.error(error); process.exitCode = 1 })
