import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AVATAR_MODEL_MAX_BYTES, validateAvatarModel } from '../../src/shared/avatarModel.ts'

const model = readFileSync(new URL('../../src/renderer/src/assets/companion/pink-ai-octopus.glb', import.meta.url))
function transform(change: (document: any) => void): Uint8Array {
  const length = model.readUInt32LE(12)
  const document = JSON.parse(model.subarray(20, 20 + length).toString())
  change(document)
  const json = Buffer.from(JSON.stringify(document))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32)
  json.copy(padded)
  const remainder = model.subarray(20 + length)
  const result = Buffer.alloc(20 + padded.length + remainder.length)
  model.copy(result, 0, 0, 20)
  result.writeUInt32LE(result.length, 8)
  result.writeUInt32LE(padded.length, 12)
  padded.copy(result, 20)
  remainder.copy(result, 20 + padded.length)
  return result
}

test('built-in octopus is a complete self-contained animated 3D mesh', () => {
  assert.doesNotThrow(() => validateAvatarModel(model))
  const document = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString())
  assert.ok(document.meshes.length > 8)
  assert.ok(document.animations.length > 0)
  assert.equal(document.buffers[0].uri, undefined)
  assert.ok(document.nodes.filter((node: any) => /tentacle/i.test(node.name || '')).length >= 8)
})

test('GLB import rejects external resources and unsupported executable or network extensions', () => {
  assert.throws(() => validateAvatarModel(transform(doc => { doc.buffers[0].uri = 'https://invalid.example/model.bin' })), /external resources/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.images = [{ uri: 'file:///private.png' }] })), /embedded PNG/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.nodes[0].extensions = { EXT_unknown: {} } })), /unsupported extension/)
})

test('GLB import rejects corrupt, truncated, oversized, out-of-bounds and cyclic content', () => {
  assert.throws(() => validateAvatarModel(model.subarray(0, model.length - 1)), /complete GLB/)
  assert.throws(() => validateAvatarModel(new Uint8Array(AVATAR_MODEL_MAX_BYTES + 1)), /15 MiB/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.bufferViews[0].byteLength = model.length * 2 })), /out of bounds/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.accessors[0].count = 1500001 })), /oversized geometry/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.nodes[0].children = [0] })), /cyclic/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.scenes[0].nodes = [0, 0] })), /duplicate scene roots/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.nodes[0].children = [1, 1] })), /single parent/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.scenes = Array(17).fill(doc.scenes[0]) })), /too complex/)
  assert.throws(() => validateAvatarModel(transform(doc => { doc.meshes[0].primitives[0].targets = Array(65).fill({}) })), /too complex/)
})
