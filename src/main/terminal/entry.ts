// A detached, user-local terminal owner: native PTY handles stay out of Electron, and a briefly lost lease
// can reconnect without replacing a live shell. It never outlives the application: once the last lease
// closes, every shell stops and the host exits (tabs are saved for "restore on startup").
import { createServer } from 'node:http'
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { TerminalHost } from './host'
import type { TerminalContext } from './host'
import type { TerminalCreateInput, TerminalPreferences } from '../../shared/terminal'

async function run() {
  const home = process.env.DAILYWORKMATE_TERMINAL_HOME!
  if (!home || !path.isAbsolute(home)) throw new Error('Invalid terminal host directory')
  const host = new TerminalHost(home, process.env.DAILYWORKMATE_TERMINAL_HELPER!, process.env.DAILYWORKMATE_TERMINAL_PTY!)
  await host.initialize()
  const token = randomBytes(32).toString('hex')
  const clients = new Set<import('node:http').ServerResponse>()
  let closing = false, draining = false, idle: ReturnType<typeof setTimeout> | undefined
  const infoFile = path.join(home, 'host.json')
  const stop = async () => {
    if (closing) return
    closing = true; clearTimeout(idle)
    try {
      await host.shutdown()
      const info = JSON.parse(await readFile(infoFile, 'utf8'))
      if (info.token === token) await unlink(infoFile)
    } catch (error) { console.error('[Terminal host] Cleanup failed:', error instanceof Error ? error.message : String(error)) }
    for (const client of clients) client.end()
    server.close(); process.exit(0)
  }
  const detached = async () => { if (!clients.size && !closing) await stop() }
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers.authorization || ''
      const expected = 'Bearer ' + token
      if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { response.writeHead(403).end(); return }
      if (closing || draining) { response.writeHead(503).end(); return }
      if (request.method === 'GET' && request.url === '/lease') {
        clearTimeout(idle); clients.add(response)
        response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('attached\n')
        const heartbeat = setInterval(() => response.write('alive\n'), 10000)
        response.on('close', () => { clearInterval(heartbeat); clients.delete(response); if (!clients.size) idle = setTimeout(() => void detached(), 1000) })
        return
      }
      if (request.method !== 'POST' || request.url !== '/command') { response.writeHead(404).end(); return }
      let raw = ''
      request.setEncoding('utf8')
      for await (const chunk of request) { raw += chunk; if (raw.length > 256 * 1024) throw new Error('Terminal request exceeds size limit') }
      const value = JSON.parse(raw)
      let result: unknown
      switch (value.action) {
        case 'ping': result = { protocol: 1, modelConnections: true }; break
        case 'sync': result = await host.sync(value.context as TerminalContext); break
        case 'state': result = host.state(); break
        case 'create': result = await host.create(value.input as TerminalCreateInput); break
        case 'select': result = await host.select(value.id); break
        case 'close': result = await host.close(value.id); break
        case 'restart': result = await host.restart(value.id); break
        case 'poll': result = host.poll(value.id, value.cursor); break
        case 'write': host.write(value.id, value.data); result = null; break
        case 'resize': host.resize(value.id, value.cols, value.rows); result = null; break
        case 'layout': result = host.saveLayout(value.tabId, value.layout); break
        case 'preferences': result = await host.setPreferences(value.preferences as TerminalPreferences); break
        // `false` tells clients from older versions that nothing is retained.
        case 'detach': await host.detach(); result = false; draining = true; idle = setTimeout(() => void stop(), 500); break
        default: throw new Error('Unknown terminal operation')
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ result }))
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Terminal operation failed' })) }
  })
  server.maxConnections = 32
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to start terminal host')
  await mkdir(home, { recursive: true })
  const temporary = infoFile + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify({ protocol: 1, port: address.port, token, pid: process.pid }), { mode: 0o600 })
  await rename(temporary, infoFile)
  idle = setTimeout(() => void detached(), 15000)
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
}
void run().catch(error => { console.error('[Terminal host] Startup failed:', error instanceof Error ? error.message : String(error)); process.exit(1) })
