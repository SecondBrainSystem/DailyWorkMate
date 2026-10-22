// Explicit live verification through the real public HTTP routes with isolated storage.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { startFreeProxy } = require('../tests/fixtures/free-proxy.cjs')
const directory = path.resolve('tmp/qa/free-proxy-live-' + Date.now())
;(async () => {
  const port = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 0
  const forceRouting = process.argv.includes('--force-routing')
  const source = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : undefined
  assert.ok(source === undefined || ['opencode', 'kilo'].includes(source), '--source must be opencode or kilo')
  let proxy
  const report = { passed: false, results: [] }
  try {
    proxy = await startFreeProxy(directory, port)
    report.endpoint = proxy.endpoint
    const headers = { Authorization: 'Bearer ' + proxy.key, 'Content-Type': 'application/json' }
    const catalog = await (await fetch(proxy.endpoint + '/v1/models', { headers, signal: AbortSignal.timeout(45_000) })).json()
    report.models = catalog.data.map(model => model.id)
    report.catalogue = { kilo: catalog.kilo, opencode: catalog.opencode }
    console.log(JSON.stringify({ endpoint: proxy.endpoint, models: report.models.length, catalogue: report.catalogue }))
    const selected = ['opencode-free/deepseek-v4.1-flash-free', 'kilo-free/cohere/north-mini-code:free'].filter(model => !source || model.startsWith(source + '-free/'))
    for (const model of selected) {
      assert.ok(report.models.includes(model), 'Smoke model not in current free catalogue: ' + model)
      if (forceRouting) proxy.api.state.config = { ...proxy.api.state.config,
        ollamaRouting: { forceModel: true, model, providerId: '', autoSelectUrl: false } }
      for (const stream of [false, true]) {
        console.log('Checking', model, 'stream=' + stream)
        const response = await fetch(proxy.endpoint + '/v1/chat/completions', { method: 'POST', headers,
          body: JSON.stringify({ model: forceRouting ? 'client-placeholder' : model, messages: [{ role: 'user', content: 'Reply with only OK.' }], max_tokens: 256, enable_thinking: false, stream,
            session_id: 'dailyworkmate-free-proxy-live-check' }), signal: AbortSignal.timeout(60_000) })
        const text = await response.text()
        assert.equal(response.status, 200, text)
        let answer, usage
        if (stream) {
          assert.match(text, /\[DONE\]/); assert.doesNotMatch(text, /"error"/)
          const packets = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
          answer = packets.map(packet => packet.choices?.[0]?.delta?.content || '').join('')
          usage = packets.findLast(packet => packet.usage)?.usage
        } else {
          const body = JSON.parse(text)
          answer = body.choices[0].message.content; usage = body.usage
        }
        assert.ok(answer.trim(), 'Empty answer')
        const log = proxy.api.state.requests.at(-1)
        assert.equal(log.providerId, model.split('/')[0])
        assert.equal(log.model, forceRouting ? 'client-placeholder' : model)
        report.results.push({ model, forceRouting, stream, status: response.status, answer, usage })
        console.log(JSON.stringify(report.results.at(-1)))
      }
    }
    report.passed = true
  } catch (error) { report.error = error.message; process.exitCode = 1 }
  finally {
    await proxy?.close()
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ passed: report.passed, error: report.error, evidence: path.join(directory, 'report.json') }))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
