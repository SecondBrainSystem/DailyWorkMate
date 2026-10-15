// Real Chromium IndexedDB migration, using an isolated profile and synthetic history.
const { app, BrowserWindow } = require('electron')
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'brand-migration-'))
app.setPath('userData', path.join(scratch, 'profile'))
buildSync({ entryPoints: [path.join(root, 'src/renderer/src/lib/brandMigration.ts')], outfile: path.join(scratch, 'migration.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'migration' })
fs.writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><title>Migration check</title><script src="migration.js"></script>')
let window
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await window.loadFile(path.join(scratch, 'index.html'))
  const result = await window.webContents.executeJavaScript(`(async () => {
    const request = item => new Promise((resolve,reject) => { item.onsuccess=()=>resolve(item.result);item.onerror=()=>reject(item.error) })
    const seed = async (name, marker) => {
      const opening=indexedDB.open(name,1);opening.onupgradeneeded=()=>{opening.result.createObjectStore('conversations',{keyPath:'conversationId'});opening.result.createObjectStore('summaries',{keyPath:'id'});opening.result.createObjectStore('metadata')}
      const db=await request(opening)
      await new Promise((resolve,reject)=>{const tx=db.transaction(['conversations','summaries','metadata'],'readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.objectStore('conversations').put({conversationId:'example',messages:[{role:'user',content:marker}],attachment:new Uint8Array([1,2,3])});tx.objectStore('summaries').put({id:'example',title:marker});tx.objectStore('metadata').put(marker,'imported')})
      db.close()
    }
    const read = async name => {const db=await request(indexedDB.open(name));const tx=db.transaction(['conversations','summaries','metadata']);const values=await Promise.all([request(tx.objectStore('conversations').get('example')),request(tx.objectStore('summaries').get('example')),request(tx.objectStore('metadata').get('imported'))]);db.close();return {message:values[0].messages[0].content,bytes:Array.from(values[0].attachment),title:values[1].title,metadata:values[2]}}
    await seed('chat2api.chat.history.v1','old chat');await seed('chat2api.companion.history.v1','old assistant');await seed('dailyworkmate.companion.history.v1','new assistant')
    localStorage.setItem('chat2api-settings','old settings')
    await migration.migrateRendererData(localStorage,indexedDB)
    await migration.migrateRendererData(localStorage,indexedDB)
    return {old:await read('chat2api.chat.history.v1'),migrated:await read('dailyworkmate.chat.history.v1'),existing:await read('dailyworkmate.companion.history.v1'),settings:localStorage.getItem('dailyworkmate-settings')}
  })()`)
  assert.deepEqual(result.old, result.migrated)
  assert.equal(result.migrated.message, 'old chat')
  assert.equal(result.existing.message, 'new assistant')
  assert.deepEqual(result.migrated.bytes, [1, 2, 3])
  assert.equal(result.settings, 'old settings')
  console.log('PASS: real Chromium settings, history, binary attachments, metadata, idempotence and existing-data preservation')
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { window?.destroy(); app.exit(process.exitCode || 0) })
