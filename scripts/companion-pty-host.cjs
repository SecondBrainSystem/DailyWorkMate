// Runs with Electron's Node mode. Native PTY handles never live in the application process.
let terminal, ending = false, exited = false
function finish(code) {
  if (ending) return
  ending = true
  // ConPTY closes asynchronously. Exiting this helper immediately can strand its shell/tools.
  if (!terminal) { process.exit(code); return }
  const timer = setTimeout(() => process.exit(code), 8000)
  const done = () => { clearTimeout(timer); process.exit(code) }
  if (exited) {
    try { terminal.kill() } catch (error) { report(error) }
    setTimeout(done, 100)
  } else {
    terminal.onExit(done)
    try { terminal.kill() } catch (error) { report(error); done() }
  }
}
function report(error) {
  const data = '\r\nOpenCode terminal error: ' + (error instanceof Error ? error.message : String(error)) + '\r\n'
  if (process.connected) process.send({ type: 'data', data })
}
process.on('message', message => {
  try {
    if (!message || typeof message !== 'object' || ending) return
    if (message.type === 'open') {
      if (terminal) throw new Error('Terminal already started')
      terminal = require(message.module).spawn(message.file, message.args, message.options)
      if (process.connected) process.send({ type: 'ready', pid: terminal.pid })
      terminal.onData(data => { if (process.connected && !ending) process.send({ type: 'data', data }) })
      terminal.onExit(({ exitCode }) => { exited = true; finish(exitCode || 0) })
    } else if (message.type === 'write') terminal?.write(message.data)
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows)
    else if (message.type === 'close') finish(0)
  } catch (error) {
    report(error)
    // Flush the friendly error before releasing all native handles.
    setTimeout(() => finish(1), 30)
  }
})
process.on('disconnect', () => finish(0))
process.on('uncaughtException', error => { report(error); finish(1) })
