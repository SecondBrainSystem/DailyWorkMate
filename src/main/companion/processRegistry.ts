import { execFile, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { stopProcessTree } from './processTree.ts'

/**
 * Helper processes (OpenCode servers, headless Claude Code) are recorded on disk while they run.
 * Windows does not end children with their parent, so after a crash the next start stops the
 * ones that survived; each record carries enough identity to never stop a reused process ID.
 */
export interface ProcessRecord {
  pid: number; kind: string; executable: string
  /** Text unique to this launch's command line, e.g. its port or session ID. */
  marker: string
  /** The process was created within this window (milliseconds since the epoch). */
  spawnedAfter: number; spawnedBefore: number
  group: boolean
}
/**
 * createdAt is NaN when the platform cannot report it; executable is '' when unknown.
 * imageOnly: only the executable file name is known (Windows without PowerShell).
 */
export interface ProcessInfo { executable: string; commandLine: string; createdAt: number; imageOnly?: boolean }
export interface ProcessPlatform {
  inspect: (pids: number[]) => Promise<Map<number, ProcessInfo>>
  kill: (pid: number, group: boolean) => Promise<void>
}

const SLACK = 2000
const registry = (home: string) => path.join(home, 'data', 'processes')
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function sameProcess(record: ProcessRecord, info: ProcessInfo, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (file: string) => platform === 'win32' ? path.win32.normalize(file).toLowerCase() : path.posix.normalize(file)
  if (info.imageOnly) {
    // A file name alone cannot tell this app's own helpers (Electron as Node) from a recorded launch.
    const image = path.win32.basename(record.executable).toLowerCase()
    return image === info.commandLine.toLowerCase() && image !== path.win32.basename(process.execPath).toLowerCase()
  }
  const executable = info.executable ? normalize(info.executable) === normalize(record.executable)
    : info.commandLine.includes(record.executable)
  // Without a creation time (fallback inspection) the command line must still identify the launch.
  const created = Number.isNaN(info.createdAt) || (info.createdAt >= record.spawnedAfter - SLACK && info.createdAt <= record.spawnedBefore + SLACK)
  return executable && !!record.marker && info.commandLine.includes(record.marker) && created
}

function validRecord(value: unknown): ProcessRecord {
  const record = value as ProcessRecord
  if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid === process.pid
    || typeof record.kind !== 'string' || typeof record.executable !== 'string' || !path.isAbsolute(record.executable)
    || typeof record.marker !== 'string' || !record.marker || !Number.isFinite(record.spawnedAfter) || !Number.isFinite(record.spawnedBefore)
    || typeof record.group !== 'boolean') throw new Error('Invalid process record')
  return { pid: record.pid, kind: record.kind, executable: record.executable, marker: record.marker,
    spawnedAfter: record.spawnedAfter, spawnedBefore: record.spawnedBefore, group: record.group }
}

/** Record a started child; the record is removed when it exits. */
export function trackProcess(home: string, child: ChildProcess, identity: Omit<ProcessRecord, 'pid'>): void {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid) return
  const file = path.join(registry(home), pid + '.json')
  const written = (async () => {
    await mkdir(registry(home), { recursive: true })
    const temporary = file + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ ...identity, pid }), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  })()
  written.catch(error => console.error('[Processes] Cannot record helper process ' + pid + '; it may survive a crash:', message(error)))
  child.once('exit', () => {
    void written.then(() => unlink(file)).catch(error => {
      if (errorCode(error) !== 'ENOENT') console.error('[Processes] Cannot remove record of exited process ' + pid + ':', message(error))
    })
  })
}

const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})
const system32 = (...parts: string[]) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)

async function inspectWindows(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const script = `$ErrorActionPreference = 'Stop'
$result = @(foreach ($id in @(${pids.join(',')})) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id)
  if ($p) { [pscustomobject]@{ pid = [int]$id; executable = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine; createdAt = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } }
})
ConvertTo-Json -InputObject $result -Compress`
  let output: string
  try {
    output = await run(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    // Without PowerShell only the image name is known (see sameProcess).
    const found = new Map<number, ProcessInfo>()
    for (const pid of pids) {
      const line = (await run(system32('tasklist.exe'), ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'])).trim()
      const image = /^"([^"]+)","(\d+)"/.exec(line)
      if (image && Number(image[2]) === pid) found.set(pid, { executable: '', commandLine: image[1], createdAt: NaN, imageOnly: true })
    }
    return found
  }
  const parsed: unknown = JSON.parse(output.trim() || '[]')
  if (!Array.isArray(parsed)) throw new Error('Invalid process inspection result')
  return new Map(parsed.map((item: { pid: unknown; executable: unknown; commandLine: unknown; createdAt: unknown }) => {
    if (!Number.isSafeInteger(item?.pid) || typeof item.executable !== 'string' || typeof item.commandLine !== 'string' || !Number.isFinite(item.createdAt)) throw new Error('Invalid process inspection result')
    return [item.pid as number, { executable: item.executable, commandLine: item.commandLine, createdAt: item.createdAt as number }]
  }))
}

async function inspectPosix(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const found = new Map<number, ProcessInfo>()
  for (const pid of pids) {
    let output = ''
    try { output = await run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args=']) }
    catch (error) { if ((error as { code?: unknown }).code === 1) continue; throw error }
    // lstart is a fixed 24-character date such as "Fri Oct 16 10:00:00 2026".
    const line = output.trim()
    if (line) found.set(pid, { executable: '', commandLine: line.slice(24).trim(), createdAt: Date.parse(line.slice(0, 24)) })
  }
  return found
}

async function killProcess(pid: number, group: boolean) {
  try { await stopProcessTree(pid, group) }
  catch (error) {
    if (process.platform !== 'win32' || errorCode(error) !== 'ENOENT') throw error
    // PowerShell is unavailable: taskkill still ends the whole tree of this verified process.
    await run(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
  }
}

export const defaultProcessPlatform: ProcessPlatform = {
  inspect: pids => process.platform === 'win32' ? inspectWindows(pids) : inspectPosix(pids),
  kill: killProcess,
}

/** Stop helpers that outlived a previous run, then forget their records. */
export async function reapStaleProcesses(home: string, platform: ProcessPlatform = defaultProcessPlatform): Promise<number[]> {
  const directory = registry(home)
  let names: string[]
  try { names = await readdir(directory) }
  catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error }
  const records: Array<{ file: string; record: ProcessRecord }> = []
  for (const name of names) {
    const file = path.join(directory, name)
    if (/\.tmp$/.test(name)) { await unlink(file); continue }
    if (!/^\d+\.json$/.test(name)) continue
    try { records.push({ file, record: validRecord(JSON.parse(await readFile(file, 'utf8'))) }) }
    catch (error) { console.error('[Processes] Discarding unreadable process record ' + name + ':', message(error)); await unlink(file) }
  }
  if (!records.length) return []
  const running = await platform.inspect(records.map(item => item.record.pid))
  const stopped: number[] = []
  for (const { file, record } of records) {
    const info = running.get(record.pid)
    if (info && sameProcess(record, info)) {
      try { await platform.kill(record.pid, record.group); stopped.push(record.pid) }
      catch (error) { console.error('[Processes] Cannot stop leftover ' + record.kind + ' process ' + record.pid + '; retrying at next start:', message(error)); continue }
      console.warn('[Processes] Stopped leftover ' + record.kind + ' process ' + record.pid + ' from a previous run')
    }
    await unlink(file)
  }
  return stopped
}

const reaping = new Map<string, Promise<void>>()
/** Start reaping once per profile; launches wait for it so a leftover server cannot hold the database. */
export function startReapingStaleProcesses(home: string, platform?: ProcessPlatform): Promise<void> {
  const existing = reaping.get(home)
  if (existing) return existing
  const pending = reapStaleProcesses(home, platform).then(() => undefined,
    error => { console.error('[Processes] Cleanup of leftover helper processes failed:', message(error)) })
  reaping.set(home, pending)
  return pending
}
export const staleProcessesReaped = (home: string): Promise<void> => reaping.get(home) || Promise.resolve()
