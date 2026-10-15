// Run with Electron. Renders the actual exported GLB using the production viewer.
const { app, BrowserWindow } = require('electron')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp', 'qa', 'octopus-preview-' + process.pid)
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const model = fs.readFileSync(path.join(root, 'deliverables', 'pink-ai-octopus.glb')).toString('base64')
buildSync({ stdin: { contents: `import { mountAvatarScene } from './src/renderer/src/components/companion/avatarScene.ts';
const bytes=Uint8Array.from(atob(${JSON.stringify(model)}),c=>c.charCodeAt(0));
window.start=async()=>{const host=document.querySelector('#viewer');const handle=await mountAvatarScene(host,bytes,{animate:false});window.avatar=handle;window.ready=true;return true};`, resolveDir: root },
  outfile: path.join(output, 'preview.js'), bundle: true, platform: 'browser', format: 'iife', alias: { '@shared': path.join(root, 'src/shared') } })
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:radial-gradient(ellipse at 50% 40%,#fffaff,#f9e8f1 65%,#eddfec);font-family:Segoe UI,sans-serif;color:#594057}h1{font-weight:600;font-size:23px;text-align:center;margin:28px 0 0}p{text-align:center;font-size:13px;letter-spacing:.03em;color:#8f7288;margin:9px}#viewer{height:720px;width:850px;margin:auto}footer{text-align:center;font-size:12px;color:#927a8c}</style><h1>Pink AI Octopus</h1><p>3D model · 8 tentacles · 48 suction cups · animated GLB</p><div id="viewer"></div><footer>Procedural 3D reconstruction of the companion character</footer><script src="preview.js"></script>')
let window
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 850, height: 865, useContentSize: true, backgroundColor: '#f7e8ef', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await window.loadFile(path.join(output, 'index.html'))
  await window.webContents.executeJavaScript('window.start()')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("canvas").length'), 1)
  fs.writeFileSync(path.join(root, 'deliverables', 'pink-ai-octopus-preview.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('window.avatar.rotate(1.05,0);window.avatar.render()')
  await new Promise(resolve => setTimeout(resolve, 200))
  fs.writeFileSync(path.join(root, 'deliverables', 'pink-ai-octopus-side.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('window.avatar.rotate(2.05,0);window.avatar.render()')
  await new Promise(resolve => setTimeout(resolve, 200))
  fs.writeFileSync(path.join(root, 'deliverables', 'pink-ai-octopus-back.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('window.avatar.dispose()')
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("canvas").length'), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, glb: 'deliverables/pink-ai-octopus.glb', previews: ['front', 'side', 'back'], disposeRemovedCanvas: true }))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { window?.destroy(); app.quit() })
