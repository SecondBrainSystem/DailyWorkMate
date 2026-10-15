import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { IPty, IWindowsPtyForkOptions } from 'node-pty'

export type TerminalProcess = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>
export type TerminalSpawn = (file: string, args: string[], options: IWindowsPtyForkOptions) => TerminalProcess

/** Keep native PTY threads in a child process so both natural exit and disconnect release them. */
export function terminalSpawner(script = path.resolve('scripts/companion-pty-host.cjs'), module = 'node-pty'): TerminalSpawn {
  return (file, args, options) => {
    const events = new EventEmitter()
    const forkOptions = { execPath: process.execPath, cwd: options.cwd, windowsHide: true,
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] as const }
    const child = fork(script, [], { ...forkOptions, stdio: [...forkOptions.stdio] })
    let closed = false
    let killer: ReturnType<typeof setTimeout> | undefined
    const send = (message: object) => {
      if (closed || !child.connected) throw new Error('Terminal process has exited')
      child.send(message, error => { if (error && !closed) events.emit('data', '\r\nTerminal connection failed: ' + error.message + '\r\n') })
    }
    child.on('message', message => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: string; data?: string }
      if (value.type === 'data' && typeof value.data === 'string') events.emit('data', value.data)
    })
    child.once('error', error => { events.emit('data', '\r\nUnable to start terminal process: ' + error.message + '\r\n') })
    child.once('exit', (code, signal) => {
      closed = true; clearTimeout(killer)
      events.emit('exit', { exitCode: code ?? (signal ? 1 : 0) })
    })
    send({ type: 'open', module, file, args, options })
    return {
      write: data => send({ type: 'write', data }), resize: (cols, rows) => send({ type: 'resize', cols, rows }),
      kill: () => {
        if (closed || killer) return
        if (child.connected) send({ type: 'close' })
        killer = setTimeout(() => child.kill(), 2000); killer.unref()
      },
      onData: listener => { events.on('data', listener); return { dispose: () => events.off('data', listener) } },
      onExit: listener => { events.on('exit', listener); return { dispose: () => events.off('exit', listener) } },
    }
  }
}
