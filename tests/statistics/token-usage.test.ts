import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import { createTokenUsageTrackingStream, extractTokenCount } from '../../src/main/proxy/tokenUsage.ts'

test('extracts OpenAI, Anthropic and Ollama token totals', () => {
  assert.equal(extractTokenCount({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }), 20)
  assert.equal(extractTokenCount({ usage: { input_tokens: 7, output_tokens: 5 } }), 12)
  assert.equal(extractTokenCount({ prompt_eval_count: 9, eval_count: 4 }), 13)
})

test('extracts the largest reported total from an SSE response', () => {
  const response = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16}}',
    '',
    'data: [DONE]',
  ].join('\n')
  assert.equal(extractTokenCount(response), 16)
})

test('tracking stream preserves output and reports usage when the stream completes', async () => {
  let reported = 0
  const tracker = createTokenUsageTrackingStream(tokens => { reported = tokens })
  const chunks: Buffer[] = []
  tracker.on('data', chunk => chunks.push(chunk))

  await new Promise<void>((resolve, reject) => {
    tracker.once('end', resolve)
    tracker.once('error', reject)
    Readable.from(['data: {"usage":{"total_tokens":24}}\n\n', 'data: [DONE]\n\n']).pipe(tracker)
  })

  assert.equal(Buffer.concat(chunks).toString(), 'data: {"usage":{"total_tokens":24}}\n\ndata: [DONE]\n\n')
  assert.equal(reported, 24)
})

test('Ollama import returns persisted URLs without waiting for a scan', () => {
  const source = readFileSync('src/main/ollama/manager.ts', 'utf8')
  const importBody = source.match(/static async importText[\s\S]*?\n  static (?:async )?scan\(/)?.[0] || ''
  assert.doesNotMatch(importBody, /await this\.scan/)
  assert.match(importBody, /nodes: this\.list\(\)/)
})

test('Dashboard wires the compact token total and collapsible per-model details', () => {
  const dashboard = readFileSync('src/renderer/src/pages/Dashboard.tsx', 'utf8')
  const card = readFileSync('src/renderer/src/components/dashboard/TokenUsageCard.tsx', 'utf8')
  assert.match(dashboard, /<TokenUsageCard/)
  assert.match(card, /useState\(false\)/)
  assert.match(card, /onSelectModel/)
  assert.match(card, /aria-expanded=\{expanded\}/)
})
