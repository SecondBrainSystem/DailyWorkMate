import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'
import { stopProcessTree } from './processTree.ts'

export type TerminalProcess = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'> & { exited?: Promise<void>; close?: () => Promise<void> }
export type TerminalSpawn = (file: string, args: string[], options: IWindowsPtyForkOptions) => TerminalProcess
const activeProcesses = new Set<TerminalProcess>()

export async function closeTerminalProcess(terminal: TerminalProcess | null | undefined) {
  if (terminal?.close) await terminal.close()
  else { terminal?.kill(); await terminal?.exited }
}
export async function closeAllTerminalProcesses() {
  const results = await Promise.allSettled([...activeProcesses].map(closeTerminalProcess))
  const errors = results.filter(result => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Terminal processes did not stop')
}

/** Keep native PTY threads in a child process so both natural exit and disconnect release them. */
export function terminalSpawner(script = path.resolve('scripts/companion-pty-host.cjs'), module = 'node-pty'): TerminalSpawn {
  return (file, args, options) => {
    const events = new EventEmitter()
    const forkOptions = { execPath: process.execPath, cwd: options.cwd, windowsHide: true,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as const }
    const child = fork(script, [], { ...forkOptions, stdio: [...forkOptions.stdio] })
    let handle: TerminalProcess
    let closed = false
    let resolveExit!: () => void
    const exited = new Promise<void>(resolve => { resolveExit = resolve })
    let shellPid: number | undefined, resolveReady!: () => void
    const ready = new Promise<void>(resolve => { resolveReady = resolve })
    let closing: Promise<void> | undefined
    let killer: ReturnType<typeof setTimeout> | undefined
    const send = (message: object) => {
      if (closed || !child.connected) throw new Error('Terminal process has exited')
      child.send(message, error => { if (error && !closed) events.emit('data', '\r\nTerminal connection failed: ' + error.message + '\r\n') })
    }
    child.on('message', message => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: string; data?: string; pid?: number }
      if (value.type === 'ready' && Number.isSafeInteger(value.pid) && value.pid! > 0) { shellPid = value.pid; resolveReady() }
      if (value.type === 'data' && typeof value.data === 'string') events.emit('data', value.data)
    })
    child.once('error', error => { events.emit('data', '\r\nUnable to start terminal process: ' + error.message + '\r\n'); closed = true; activeProcesses.delete(handle); resolveReady(); resolveExit() })
    child.once('exit', (code, signal) => {
      closed = true; clearTimeout(killer)
      activeProcesses.delete(handle)
      events.emit('exit', { exitCode: code ?? (signal ? 1 : 0) })
      resolveExit()
      resolveReady()
    })
    send({ type: 'open', module, file, args, options })
    const close = () => closing ||= (async () => {
      await ready
      if (closed) return
      if (shellPid) await stopProcessTree(shellPid)
      if (!closed && child.connected) send({ type: 'close' })
      killer = setTimeout(() => child.kill(), 10000); killer.unref()
      await exited
    })().catch(error => { closing = undefined; throw error })
    handle = {
      exited, close,
      write: data => send({ type: 'write', data }), resize: (cols, rows) => send({ type: 'resize', cols, rows }),
      kill: () => { void close().catch(error => console.error('[Terminal] Process cleanup failed:', error)) },
      onData: listener => { events.on('data', listener); return { dispose: () => events.off('data', listener) } },
      onExit: listener => { events.on('exit', listener); return { dispose: () => events.off('exit', listener) } },
    }
    activeProcesses.add(handle)
    return handle
  }
}
