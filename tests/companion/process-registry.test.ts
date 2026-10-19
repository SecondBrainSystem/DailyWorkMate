import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { reapStaleProcesses, sameProcess, trackProcess, type ProcessInfo, type ProcessRecord } from '../../src/main/companion/processRegistry.ts'

const executable = path.resolve('runtime', 'opencode.exe')
const record = (pid: number, extra: Partial<ProcessRecord> = {}): ProcessRecord => ({ pid, kind: 'opencode', executable, marker: '--port 41234', spawnedAfter: 1_000_000, spawnedBefore: 1_000_050, group: false, ...extra })
const info = (extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ executable, commandLine: '"' + executable + '" serve --hostname 127.0.0.1 --port 41234', createdAt: 1_000_020, ...extra })
async function home() {
  await mkdir(path.resolve('tmp'), { recursive: true })
  return mkdtemp(path.join(path.resolve('tmp'), 'processes-'))
}
const wait = async (condition: () => Promise<boolean>) => { for (let index = 0; index < 100 && !await condition(); index++) await new Promise(resolve => setTimeout(resolve, 5)) }

test('a recorded process is recognized only by executable, launch marker and creation time', () => {
  assert.equal(sameProcess(record(10), info()), true)
  assert.equal(sameProcess(record(10), info({ createdAt: 1_000_000 + 60_000 })), false, 'a reused process ID started later')
  assert.equal(sameProcess(record(10), info({ commandLine: '"' + executable + '" serve --port 9999' })), false)
  assert.equal(sameProcess(record(10), info({ executable: path.resolve('other.exe') })), false)
  assert.equal(sameProcess(record(10), info({ executable: '', createdAt: NaN })), true, 'POSIX inspection matches the command line')
  assert.equal(sameProcess(record(10), { executable: '', commandLine: 'opencode.exe', createdAt: NaN, imageOnly: true }), true)
  assert.equal(sameProcess(record(10, { executable: process.execPath }), { executable: '', commandLine: path.basename(process.execPath), createdAt: NaN, imageOnly: true }), false,
    'image-only inspection never stops processes that run this app’s own executable')
})

test('startup stops verified leftovers, keeps unverified processes running and clears every record', async () => {
  const directory = path.join(await home(), 'data', 'processes')
  await mkdir(directory, { recursive: true })
  for (const item of [record(101), record(102), record(103)]) await writeFile(path.join(directory, item.pid + '.json'), JSON.stringify(item))
  await writeFile(path.join(directory, '104.json'), '{broken')
  await writeFile(path.join(directory, '105.json.abc.tmp'), '{}')
  const killed: number[] = []
  const stopped = await reapStaleProcesses(path.dirname(path.dirname(directory)), {
    inspect: async pids => new Map(pids.flatMap((pid): Array<[number, ProcessInfo]> => pid === 101 ? [[pid, info()]] : pid === 102 ? [[pid, info({ createdAt: 9_000_000 })]] : [])),
    kill: async pid => { killed.push(pid) },
  })
  assert.deepEqual(stopped, [101]); assert.deepEqual(killed, [101])
  assert.deepEqual(await readdir(directory), [])
})

test('a leftover that cannot be stopped is kept for the next start', async () => {
  const root = await home()
  const directory = path.join(root, 'data', 'processes')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, '201.json'), JSON.stringify(record(201)))
  await reapStaleProcesses(root, { inspect: async () => new Map([[201, info()]]), kill: async () => { throw new Error('Access denied') } })
  assert.deepEqual(await readdir(directory), ['201.json'])
})

test('tracked children are recorded while running and forgotten when they exit', async () => {
  const root = await home()
  const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as ChildProcess
  trackProcess(root, child, { kind: 'claude-code', executable, marker: 'session', spawnedAfter: 1, spawnedBefore: 2, group: false })
  const directory = path.join(root, 'data', 'processes')
  await wait(async () => (await readdir(directory).catch(() => [])).includes('4242.json'))
  assert.deepEqual(await readdir(directory), ['4242.json'])
  child.emit('exit', 0)
  await wait(async () => !(await readdir(directory)).length)
  assert.deepEqual(await readdir(directory), [])
})
