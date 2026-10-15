// Startup and memory measurement for the built app (out/), in an isolated profile.
// Usage: node scripts/measure-startup.cjs [runs]   (run `npm run build` first)
// Each run starts a fresh Electron process with its own home, companion data and user-data folders.
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const root = path.resolve(__dirname, '..')

if (process.env.DAILYWORKMATE_MEASURE_HOOK) {
  // Runs inside Electron's main process (via NODE_OPTIONS --require) before the app's own code.
  const { app, ipcMain } = require('electron')
  const started = Number(process.env.DAILYWORKMATE_MEASURE_START) || Date.now()
  const marks = { hookLoaded: Date.now() - started }
  // Optional main-process CPU profile from launch until the assistant is ready.
  const profiler = process.env.DAILYWORKMATE_MEASURE_PROFILE ? new (require('node:inspector').Session)() : null
  if (profiler) { profiler.connect(); profiler.post('Profiler.enable'); profiler.post('Profiler.setSamplingInterval', { interval: 500 }); profiler.post('Profiler.start') }
  // Every IPC call during startup: channel, start (ms since launch), duration.
  const ipc = []
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
    const at = Date.now()
    try { return await handler(...args) } finally { ipc.push([channel, at - started, Date.now() - at]) }
  })
  app.setPath('userData', path.join(process.env.DAILYWORKMATE_MEASURE_DIR, 'userData'))
  // Experiment with Chromium switches, e.g. DAILYWORKMATE_MEASURE_SWITCHES=disable-gpu-compositing
  for (const item of (process.env.DAILYWORKMATE_MEASURE_SWITCHES || '').split(',').filter(Boolean)) { const [name, value] = item.split('='); if (value) app.commandLine.appendSwitch(name, value); else app.commandLine.appendSwitch(name) }
  app.once('ready', () => { marks.appReady = Date.now() - started })
  app.once('browser-window-created', (_event, window) => {
    marks.windowCreated = Date.now() - started
    window.once('ready-to-show', () => { marks.readyToShow = Date.now() - started })
    window.webContents.once('did-finish-load', () => { marks.didFinishLoad = Date.now() - started })
    const timer = setInterval(async () => {
      try {
        if (!(await window.webContents.executeJavaScript(`!!document.querySelector('[data-companion-ready="true"]')`))) return
        clearInterval(timer)
        marks.assistantReady = Date.now() - started
        if (profiler) profiler.post('Profiler.stop', (error, result) => { if (!error) fs.writeFileSync(path.join(process.env.DAILYWORKMATE_MEASURE_DIR, 'main.cpuprofile'), JSON.stringify(result.profile)) })
        setTimeout(async () => {
          // CPU over a 10 s idle window with the assistant page visible (avatar animating).
          app.getAppMetrics()
          const cpuStart = Date.now()
          await new Promise(resolve => setTimeout(resolve, 10000))
          const fps = await window.webContents.executeJavaScript('new Promise(resolve => { let n = 0; const start = performance.now(); const tick = () => { n++; if (performance.now() - start < 3000) requestAnimationFrame(tick); else resolve(Math.round(n / 3)) }; requestAnimationFrame(tick) })')
          marks.fps = fps
          marks.avatar3d = await window.webContents.executeJavaScript('!!document.querySelector("[data-avatar-3d=ready]")')
          const cpu = Object.fromEntries(app.getAppMetrics().map(item => [item.type + ':' + item.pid, Math.round(item.cpu.percentCPUUsage * 10) / 10]))
          marks.cpuWindowMs = Date.now() - cpuStart
          const resources = await window.webContents.executeJavaScript(`performance.getEntriesByType('resource').map(entry => [entry.name.split('/').pop().slice(0, 50), Math.round(entry.startTime), Math.round(entry.duration), entry.transferSize || entry.encodedBodySize || 0])`)
          const chromium = app.getAppMetrics().map(item => ({ type: item.type, pid: item.pid, workingSetKB: item.memory.workingSetSize, privateKB: item.memory.privateBytes }))
          fs.writeFileSync(path.join(process.env.DAILYWORKMATE_MEASURE_DIR, 'result.json'), JSON.stringify({ marks, chromium, cpu, mainPid: process.pid, ipc, resources, mainMemory: process.memoryUsage(), rendererHeap: await window.webContents.executeJavaScript('performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null') }))
          app.exit(0)
        }, Number(process.env.DAILYWORKMATE_MEASURE_SETTLE) || 15000)
      } catch { /* page still loading */ }
    }, 50)
  })
  return
}

function descendants(rootPid) {
  const rows = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  const found = [], queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()
    for (const row of rows) if (row.ParentProcessId === pid) { found.push(row); queue.push(row.ProcessId) }
  }
  return found.map(row => ({ pid: row.ProcessId, name: row.Name, workingSetMB: Math.round(row.WorkingSetSize / 1048576), privateMB: Math.round(row.PrivatePageCount / 1048576), role: /--type=(\w[\w-]*)/.exec(row.CommandLine || '')?.[1] || (row.CommandLine || '').split(/[\\/]/).pop()?.slice(0, 60) }))
}

async function run(index) {
  const dir = fs.mkdtempSync(path.join(root, 'tmp', 'startup-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  if (process.argv.includes('--real-data')) {
    // Copies only; the user's own folders are never written. Needs the same Windows user for stored secrets.
    const copy = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }) }
    copy(path.join(os.homedir(), '.dailyworkmate'), path.join(home, '.dailyworkmate'))
    copy(path.join(root, 'dist', 'companion', 'data'), path.join(dir, 'companion', 'data'))
    for (const name of ['IndexedDB', 'Local Storage']) copy(path.join(process.env.APPDATA || '', 'dailyworkmate', name), path.join(dir, 'userData', name))
    const settings = path.join(dir, 'companion', 'data', 'companion.json')
    if (process.argv.includes('--avatar-3d') && fs.existsSync(settings)) {
      const saved = JSON.parse(fs.readFileSync(settings, 'utf8'))
      fs.writeFileSync(settings, JSON.stringify({ ...saved, settings: { ...saved.settings, avatarMode: '3d', avatarVisible: true } }))
    }
  }
  const electron = require('electron')
  const started = Date.now()
  // Electron's -r preloads this file in the real main process (NODE_OPTIONS would also reach helper processes).
  const child = spawn(electron, ['-r', __filename, '.'], { cwd: root, stdio: 'ignore', env: { ...process.env,
    DAILYWORKMATE_MEASURE_HOOK: '1', DAILYWORKMATE_MEASURE_DIR: dir, DAILYWORKMATE_MEASURE_START: String(started),
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    DAILYWORKMATE_COMPANION_HOME: path.join(dir, 'companion'), NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' } })
  let processes = []
  const sampler = setInterval(() => { try { if (child.pid) processes = descendants(child.pid) } catch { /* process exiting */ } }, 4000)
  await new Promise(resolve => child.once('exit', resolve))
  clearInterval(sampler)
  const file = path.join(dir, 'result.json')
  if (!fs.existsSync(file)) throw new Error('Run ' + index + ' produced no result; see ' + dir)
  const result = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { ...result, processes }
}

;(async () => {
  const runs = Number(process.argv.find(arg => /^\d+$/.test(arg))) || 3
  const results = []
  for (let index = 0; index < runs; index++) results.push(await run(index))
  const median = key => { const values = results.map(item => item.marks[key]).filter(Number.isFinite).sort((a, b) => a - b); return values[Math.floor(values.length / 2)] }
  console.log('startup ms (median of ' + runs + '):', Object.fromEntries(['appReady', 'windowCreated', 'didFinishLoad', 'readyToShow', 'assistantReady'].map(key => [key, median(key)])))
  const last = results.at(-1)
  const total = last.processes.reduce((sum, item) => sum + item.privateMB, 0)
  console.log('processes after settle (last run):')
  for (const item of last.processes) console.log('  ' + String(item.pid).padEnd(7) + (item.role || item.name).padEnd(28) + ' ws ' + String(item.workingSetMB).padStart(4) + ' MB  private ' + String(item.privateMB).padStart(4) + ' MB')
  console.log('total private MB (children of electron launcher):', total)
  fs.writeFileSync(path.join(root, 'tmp', 'startup-latest.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
