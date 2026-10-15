import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeOllamaAuth, buildOllamaHeaders } from '../../src/main/ollama/transport.ts'
import { normalizeOllamaUrl } from '../../src/main/ollama/urls.ts'

test('authentication preserves omitted fields, removes stale methods, and leaves inputs unchanged', () => {
  const previous = Object.freeze({authType:'basic',username:'user',password:'saved'})
  const next = mergeOllamaAuth({type:'basic',username:'new'},previous)
  assert.equal(next.password,'saved')
  assert.equal(buildOllamaHeaders({credentials:next}).authorization,`Basic ${Buffer.from('new:saved').toString('base64')}`)
  assert.deepEqual(mergeOllamaAuth({type:'none'},previous),{authType:'none'})
})

test('invalid auth input and URL-embedded credentials are rejected before persistence', () => {
  for (const input of [{type:'unknown'}, {type:'bearer',token:'x\r\nInjected: y'}, {type:'api-key',headerName:'Host',headerValue:'wrong'}, {type:'api-key',headerName:'X-API-Key',headerValue:''}]) {
    assert.throws(()=>mergeOllamaAuth(input as any,{}))
  }
  assert.throws(()=>normalizeOllamaUrl('https://user:secret@example.com'),/authentication/)
  assert.throws(()=>mergeOllamaAuth({type:'bearer'},{}),/token/)
})
