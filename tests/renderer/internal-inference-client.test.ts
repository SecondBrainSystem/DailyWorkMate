import test from 'node:test'
import assert from 'node:assert/strict'
import { internalInferenceFetch } from '../../src/renderer/src/lib/internalInferenceClient.ts'

type Event = { id: string; data?: string; done?: boolean; error?: string }
type Input = { id: string; path: string; method: string; body?: unknown; headers: Record<string, string> }
type Result = { status: number; headers: Record<string, string>; body?: unknown; stream?: boolean }
function bridge(request: (input: Input, emit: (event: Event) => void) => Promise<Result>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const listeners = new Set<(event: Event) => void>()
  const cancelled: string[] = [], calls: Input[] = []
  const emit = (event: Event) => { for (const listener of [...listeners]) listener(event) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    proxy: { start() { assert.fail('Internal requests must not start the public API') }, stop() { assert.fail('Internal requests must not stop the public API') } },
    inference: {
      request(input: Input) { calls.push(input); return request(input, emit) },
      onData(listener: (event: Event) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      async cancel(id: string) { cancelled.push(id) },
    },
  } } })
  return { emit, cancelled, calls, listeners, restore() {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  } }
}

test('internal requests return JSON without starting the public API or using fetch', async () => {
  const mock = bridge(async input => {
    assert.equal(input.path, '/v1/models/verify')
    assert.deepEqual(input.body, { model: 'selected' })
    assert.equal(input.headers.authorization, undefined)
    return { status: 200, headers: { 'content-type': 'application/json' }, body: { model: 'selected', verified: true } }
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { assert.fail('Renderer model requests must not use HTTP') }
  try {
    const response = await internalInferenceFetch('/v1/models/verify', { method: 'POST', body: JSON.stringify({ model: 'selected' }) })
    assert.deepEqual(await response.json(), { model: 'selected', verified: true })
    assert.equal(mock.listeners.size, 0)
    assert.equal(mock.cancelled.length, 0)
  } finally { globalThis.fetch = previousFetch; mock.restore() }
})

test('concurrent model streams retain early chunks and never mix request data', async () => {
  const mock = bridge(async (input, emit) => {
    emit({ id: input.id, data: (input.body as { model: string }).model + ':早期' })
    return { status: 200, headers: {}, stream: true }
  })
  try {
    const [first, second] = await Promise.all(['first', 'second'].map(model => internalInferenceFetch('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model }) })))
    const results = [first.text(), second.text()]
    mock.emit({ id: 'unrelated', data: 'must not leak' })
    mock.emit({ id: mock.calls[1].id, data: ':第二', done: true })
    mock.emit({ id: mock.calls[0].id, data: ':第一', done: true })
    assert.deepEqual(await Promise.all(results), ['first:早期:第一', 'second:早期:第二'])
    assert.equal(mock.listeners.size, 0)
  } finally { mock.restore() }
})

test('aborting while headers are pending rejects promptly and cancels the same backend request once', async () => {
  const mock = bridge(async () => new Promise<Result>(() => {}))
  try {
    const controller = new AbortController()
    const response = internalInferenceFetch('/v1/chat/completions', { signal: controller.signal })
    controller.abort()
    await assert.rejects(response, { name: 'AbortError' })
    assert.deepEqual(mock.cancelled, [mock.calls[0].id])
    assert.equal(mock.listeners.size, 0)
  } finally { mock.restore() }
})

test('aborting an active stream cancels upstream and releases the event subscription', async () => {
  const mock = bridge(async () => ({ status: 200, headers: {}, stream: true }))
  try {
    const controller = new AbortController()
    const response = await internalInferenceFetch('/v1/chat/completions', { signal: controller.signal })
    const content = response.text()
    controller.abort()
    await assert.rejects(content, { name: 'AbortError' })
    assert.deepEqual(mock.cancelled, [mock.calls[0].id])
    assert.equal(mock.listeners.size, 0)
  } finally { mock.restore() }
})

test('reader cancellation, upstream stream errors and invoke failure clean up request listeners', async () => {
  const mock = bridge(async input => {
    if (input.path === '/v1/models') throw new Error('Unavailable provider')
    return { status: 200, headers: {}, stream: true }
  })
  try {
    const response = await internalInferenceFetch('/v1/chat/completions')
    await response.body!.cancel()
    assert.deepEqual(mock.cancelled, [mock.calls[0].id])
    assert.equal(mock.listeners.size, 0)
    const errorResponse = await internalInferenceFetch('/v1/chat/completions')
    mock.emit({ id: mock.calls[1].id, error: 'Upstream stopped' })
    await assert.rejects(errorResponse.text(), /Upstream stopped/)
    assert.equal(mock.listeners.size, 0)
    await assert.rejects(internalInferenceFetch('/v1/models'), /Unavailable provider/)
    assert.equal(mock.listeners.size, 0)
  } finally { mock.restore() }
})

test('already aborted requests never enter the bridge', async () => {
  const mock = bridge(async () => { throw new Error('Should not run') })
  try {
    await assert.rejects(internalInferenceFetch('/v1/models', { signal: AbortSignal.abort() }), { name: 'AbortError' })
    assert.equal(mock.calls.length, 0)
    assert.equal(mock.listeners.size, 0)
  } finally { mock.restore() }
})
