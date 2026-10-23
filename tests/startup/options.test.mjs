import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let readStartupOptions, saveStartupOptions
before(async () => {
  await mkdir('tmp/qa', { recursive: true })
  const output = path.resolve('tmp/qa/startup-options-tests.mjs')
  await build({ entryPoints: ['src/main/startupOptions.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm' })
  ;({ readStartupOptions, saveStartupOptions } = await import(pathToFileURL(output).href))
})

test('GPU compositing defaults on, while an explicit driver fallback survives saving and restarting', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dailyworkmate-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'settings', 'startup.json')
  assert.deepEqual(readStartupOptions(file), { gpuCompositing: true })
  for (const gpuCompositing of [false, true]) {
    saveStartupOptions({ gpuCompositing }, file)
    assert.deepEqual(readStartupOptions(file), { gpuCompositing })
  }
  for (const content of ['{}', 'null', '{"gpuCompositing":"false"}', '{']) {
    await writeFile(file, content)
    assert.deepEqual(readStartupOptions(file), { gpuCompositing: true })
    assert.equal(await readFile(file, 'utf8'), content, 'reading never rewrites user configuration')
  }
  assert.throws(() => saveStartupOptions({ gpuCompositing: 'false' }, file), /Invalid startup options/)
})
