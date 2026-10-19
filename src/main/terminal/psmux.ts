import { readdir, readFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Registry identity stays in the main process; authentication keys are never sent to the UI. */
export interface PsmuxSession { name: string; directory: string; port: number; key: string; identity: string }

async function smallFile(file: string) {
  if ((await stat(file)).size > 4096) throw new Error('Invalid psmux registry file')
  return (await readFile(file, 'utf8')).trim()
}

// psmux's local, authenticated one-shot protocol. Authenticate before issuing any command.
// https://github.com/psmux/psmux/blob/master/docs/architecture.md
function contact(session: PsmuxSession, command?: 'kill-session'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: session.port })
    let response = '', settled = false
    const finish = (alive: boolean, error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(alive)
    }
    const timer = setTimeout(() => finish(false, new Error('psmux did not respond in time')), 2000)
    socket.once('connect', () => socket.write('AUTH ' + session.key + '\n'))
    socket.setEncoding('utf8')
    socket.on('data', data => {
      response += data
      if (response.length > 4096) { finish(false, new Error('Invalid psmux response')); return }
      if (!response.includes('\n')) return
      if (!/^OK(?:\s|$)/.test(response)) { finish(false); return }
      if (command) socket.write(command + '\n', error => finish(!error, error || undefined))
      else finish(true)
    })
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish(false)
      else finish(false, error)
    })
    socket.once('end', () => finish(false))
  })
}

export const defaultPsmuxDirectories = () => [...new Set([path.join(os.homedir(), '.psmux'), ...(process.env.PSMUX_DATA_DIR ? [process.env.PSMUX_DATA_DIR] : [])])]
/**
 * Sessions that answered authentication. Discovery runs inside the quit confirmation, so an unreadable registry
 * entry or a port held by another program counts as "not alive" (and is logged) instead of blocking the exit.
 * closePsmux stays strict for the sessions the user confirmed.
 */
export async function discoverPsmux(directories = defaultPsmuxDirectories()): Promise<PsmuxSession[]> {
  if (process.platform !== 'win32') return []
  const sessions: PsmuxSession[] = []
  for (const directory of [...new Set(directories)]) {
    if (!path.isAbsolute(directory)) { console.error('[psmux] Skipped relative data directory:', directory); continue }
    let files: string[]
    try { files = await readdir(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[psmux] Unable to read ' + directory + ':', error instanceof Error ? error.message : String(error))
      continue
    }
    const candidates = files.filter(file => file.endsWith('.port'))
    if (candidates.length > 256) { console.error('[psmux] Skipped ' + directory + ': too many sessions to check safely (' + candidates.length + ')'); continue }
    const found = await Promise.all(candidates.map(async file => {
      const name = file.slice(0, -5)
      try {
        const [rawPort, key, identity] = await Promise.all(['.port', '.key', '.pid'].map(extension => smallFile(path.join(directory, name + extension))))
        const port = Number(rawPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9_-]{16,512}$/.test(key) || !/^\d+(?::\d+)?$/.test(identity)) throw new Error('Invalid psmux registry')
        const session = { name, directory, port, key, identity }
        return await contact(session) ? session : undefined
      } catch (error) {
        // ENOENT: the session ended during the scan.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[psmux] Treating ' + path.join(directory, name) + ' as not running:', error instanceof Error ? error.message : String(error))
        return undefined
      }
    }))
    sessions.push(...found.filter((session): session is PsmuxSession => !!session))
  }
  return sessions
}

/** Close only the identities shown in the confirmation, never a newly created/replaced session. */
export async function closePsmux(sessions: PsmuxSession[], includeWarm = true) {
  for (const session of sessions) {
    try {
      const [identity, key] = await Promise.all(['.pid', '.key'].map(extension => smallFile(path.join(session.directory, session.name + extension))))
      if (identity !== session.identity || key !== session.key) throw new Error('psmux session changed; confirm exit again')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (!await contact(session, 'kill-session')) continue
    const deadline = Date.now() + 10000
    while (await contact(session)) {
      if (Date.now() > deadline) throw new Error('psmux session did not stop: ' + session.name)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (includeWarm && sessions.length) {
    // The warm pool can be published just after the confirmation snapshot. It has no user task.
    // Close only standby servers in the confirmed namespaces, never new named sessions.
    const warmNames = new Set(sessions.map(session => session.directory + '\0' + (session.name.endsWith('__warm__') ? session.name :
      (session.name.includes('__') ? session.name.slice(0, session.name.indexOf('__') + 2) : '') + '__warm__')))
    await new Promise(resolve => setTimeout(resolve, 300))
    const warm = (await discoverPsmux(sessions.map(session => session.directory))).filter(session => warmNames.has(session.directory + '\0' + session.name))
    await closePsmux(warm, false)
  }
}
