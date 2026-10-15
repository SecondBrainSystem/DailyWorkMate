// Production React avatar in an isolated hidden Electron window, no remote requests.
const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'tmp', 'qa', 'avatar-3d-' + process.pid)
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'))
const builtin = 'data:model/gltf-binary;base64,' + fs.readFileSync(path.join(root, 'deliverables/pink-ai-octopus.glb')).toString('base64')
const bundled = build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Avatar} from './src/renderer/src/components/companion/Avatar.tsx';
window.contexts=[];const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(window.denyWebGL&&type.startsWith('webgl'))return null;const context=original.call(this,type,...args);if(context&&type==='webgl2')window.contexts.push(context);return context};
const root=createRoot(document.querySelector('#root'));let props={state:'idle',image:'',name:'QA octopus',level:0,avatarMode:'2d'};window.updateAvatar=value=>{props={...props,...value};root.render(<Avatar {...props}/>)};window.updateAvatar({});window.customModel=${JSON.stringify(builtin)};`, resolveDir: root, loader: 'tsx' },
  outfile: path.join(output, 'avatar.js'), bundle: true, platform: 'browser', format: 'iife', loader: { '.png': 'dataurl' }, alias: { '@': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') },
  plugins: [{ name: 'inline-glb', setup(build) { build.onResolve({ filter: /\.glb\?url$/ }, () => ({ path: 'builtin-model', namespace: 'avatar-asset' })); build.onLoad({ filter: /.*/, namespace: 'avatar-asset' }, () => ({ contents: 'export default ' + JSON.stringify(builtin), loader: 'js' })) } }] })
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f5edf3;color:#57445a;font-family:Segoe UI}.companion-avatar{height:345px;width:360px;position:relative;display:grid;place-items:center;margin:26px auto}.companion-custom-avatar{height:300px;max-width:100%;object-fit:contain}.companion-spark{display:none}#root{padding-top:6px}</style><div id="root"></div><script src="avatar.js"></script>')
let window
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
async function until(code) { for (let i = 0; i < 160; i++) { if (await js(code)) return; await wait(50) } throw new Error('Timeout: ' + code) }
app.whenReady().then(async () => {
  await bundled
  window = new BrowserWindow({ show: false, width: 430, height: 420, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const network = []
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) network.push(details.url); callback({ cancel: /^https?:/.test(details.url) }) })
  await window.loadFile(path.join(output, 'index.html'))
  await until('document.querySelector("img")')
  await js('window.updateAvatar({avatarMode:"3d"})')
  await until('document.querySelector("[data-avatar-3d=ready]")')
  assert.equal(await js('document.querySelectorAll("canvas").length'), 1)
  await wait(500)
  fs.writeFileSync(path.join(root, 'deliverables/pink-ai-octopus-in-app.png'), (await window.webContents.capturePage()).toPNG())
  await js('window.previousCanvas=document.querySelector("canvas");window.updateAvatar({modelUrl:window.customModel,state:"speaking",level:.7})')
  await until('document.querySelector("[data-avatar-3d=ready]") && document.querySelector("canvas")!==window.previousCanvas')
  assert.equal(await js('window.contexts[0].isContextLost()'), true)
  await js('document.querySelector("[tabindex]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));window.updateAvatar({avatarMode:"2d"})')
  await until('document.querySelector("img") && !document.querySelector("canvas")')
  assert.equal(await js('window.contexts.every(context=>context.isContextLost())'), true)
  await js('window.updateAvatar({avatarMode:"3d",modelUrl:"https://invalid.example/model.glb"})')
  await until('document.querySelector("[data-avatar-fallback]")')
  assert.equal(await js('document.querySelectorAll("canvas").length'), 0)
  assert.equal(network.length, 0, 'Invalid external model must never issue a request')
  await js('window.updateAvatar({avatarMode:"2d",modelUrl:""});window.denyWebGL=true')
  await wait(100)
  await js('window.updateAvatar({avatarMode:"3d"})')
  await until('document.querySelector("[data-avatar-fallback]")?.textContent.includes("WebGL")')
  assert.ok(await js('document.querySelector("img")'))
  console.log(JSON.stringify({ passed: true, builtin: true, customGLB: true, releasedContexts: true, externalRequests: network.length, webglFallback: true, screenshot: 'deliverables/pink-ai-octopus-in-app.png' }))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { window?.destroy(); app.quit() })
