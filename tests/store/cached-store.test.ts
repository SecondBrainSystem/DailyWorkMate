import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Conf from 'conf'
import { cachedStore } from '../../src/main/store/cachedStore.ts'

test('reads come from memory while every write reaches the encrypted file', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cached-store-'))
  try {
    const options = { cwd, configName: 'data', projectName: 'qa', encryptionKey: 'qa-key', defaults: { config: { port: 1 }, providers: [] as unknown[] } }
    const disk = new Conf<Record<string, unknown>>(options)
    let reads = 0
    const counted = new Proxy(disk, { get(target, property, receiver) { if (property === 'store') reads++; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value } }) as any
    const store = cachedStore(counted)
    const startReads = reads
    for (let index = 0; index < 200; index++) store.get('config')
    assert.equal(reads, startReads, 'gets do not decrypt the file again')

    const returned = store.get('config')
    returned.port = 99
    assert.equal(store.get('config').port, 1, 'callers cannot change the cache through returned objects')

    store.set('providers', [{ id: 'a', when: new Date(0), skip: undefined }])
    assert.deepEqual(store.get('providers'), [{ id: 'a', when: '1970-01-01T00:00:00.000Z' }], 'values read back as persisted JSON')
    store.set({ sessions: [1] })
    assert.equal(store.get('config.port'), 1)
    assert.equal(store.get('missing', 'fallback'), 'fallback')
    assert.throws(() => store.set('config', undefined), /delete/)

    const reopened = new Conf<Record<string, unknown>>(options)
    assert.deepEqual(reopened.get('providers'), [{ id: 'a', when: '1970-01-01T00:00:00.000Z' }])
    assert.deepEqual(reopened.get('sessions'), [1])

    store.delete('sessions')
    assert.equal(store.get('sessions'), undefined)
    assert.equal(new Conf<Record<string, unknown>>(options).get('sessions'), undefined)
    store.clear()
    assert.deepEqual(store.get('providers'), [], 'clear restores defaults')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
