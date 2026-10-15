import test from 'node:test'
import assert from 'node:assert/strict'
import { impossibleTimingReason, syntheticCatalogReason } from '../../src/main/ollama/authenticity.ts'

test('a catalog whose models are exactly evenly spaced is flagged as imitation', () => {
  // Pattern served by the reported node: one day plus 7.919 s between every model.
  const start = Date.parse('2026-09-24T21:39:58.015Z')
  const generated = { models: Array.from({ length: 8 }, (_, index) => ({ name: 'm' + index, modified_at: new Date(start + index * 86_407_919).toISOString().replace('Z', '27933Z') })) }
  assert.match(syntheticCatalogReason(generated) || '', /exactly 86407\.919 s apart/)

  const real = { models: ['2026-09-01T10:00:00.1Z', '2026-09-03T08:12:44.9Z', '2026-09-03T08:15:02.3Z', '2026-09-20T22:01:10.0Z', '2026-10-02T06:30:00.7Z'].map(modified_at => ({ modified_at })) }
  assert.equal(syntheticCatalogReason(real), undefined)
  assert.equal(syntheticCatalogReason({ models: generated.models.slice(0, 4) }), undefined, 'too few models to judge')
  const sameInstant = { models: Array.from({ length: 6 }, () => ({ modified_at: '2026-10-14T07:27:58.378Z' })) }
  assert.equal(syntheticCatalogReason(sameInstant), undefined, 'catalogs stamped with one time (such as DailyWorkMate itself) are not flagged')
  assert.equal(syntheticCatalogReason({ data: [] }), undefined)
})

test('server time longer than the round trip is flagged; real timing is not', () => {
  // Observed: 2.09 s reported for a reply that arrived in 0.33 s.
  assert.match(impossibleTimingReason({ total_duration: 2_090_093_748 }, 330) || '', /reported 2\.09 s .* 0\.33 s/)
  assert.equal(impossibleTimingReason({ total_duration: 1_200_000_000 }, 1_450), undefined)
  assert.equal(impossibleTimingReason({ total_duration: 900_000_000 }, 600), undefined, 'clock jitter below 0.5 s is tolerated')
  assert.equal(impossibleTimingReason({}, 100), undefined)
  assert.equal(impossibleTimingReason({ total_duration: 'n/a' }, 100), undefined)
})
