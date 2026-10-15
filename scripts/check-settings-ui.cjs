// Production renderer QA with hidden windows, isolated storage and mocked IPC.
const {app,BrowserWindow}=require('electron')
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path')
const labels=require('../src/renderer/src/i18n/locales/en-US.json')
const root=path.resolve(__dirname,'..'), output=path.join(root,'tmp','qa'), results=[], errors=[]
fs.mkdirSync(output,{recursive:true})
app.setPath('userData',path.join(output,'settings-ui-profile-'+process.pid))
app.disableHardwareAcceleration()
let win
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const js=code=>win.webContents.executeJavaScript(code,true)
const control=(text,selector='button')=>`[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)})`
async function waitFor(code,label){
  for(let i=0;i<100;i++){if(await js(code)) return; await delay(40)}
  throw new Error('Timed out: '+label)
}
async function click(code){
  const point=await js(`(()=>{const el=(${code});if(!el)throw new Error('Missing control');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
  await delay(100)
}
async function database(seed=false){
  return js(`new Promise((resolve,reject)=>{
    const open=indexedDB.open('dailyworkmate.chat.history.v1',1);
    open.onupgradeneeded=()=>{const db=open.result;db.createObjectStore('conversations',{keyPath:'conversationId'});db.createObjectStore('summaries',{keyPath:'id'});db.createObjectStore('metadata')};
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,names=['conversations','summaries','metadata'],tx=db.transaction(names,${JSON.stringify(seed?'readwrite':'readonly')}),result={};
      if(${seed}){
        tx.objectStore('conversations').put({conversationId:'old',messages:[{content:'Private old conversation'}]});
        tx.objectStore('summaries').put({id:'old',title:'Old conversation'});
        tx.objectStore('metadata').put('old','activeId');
      }
      for(const name of names){const req=tx.objectStore(name).count();req.onsuccess=()=>{result[name]=req.result}};
      tx.oncomplete=()=>{db.close();resolve(result)};
    }
  })`)
}
const timeout=setTimeout(()=>{console.error('Settings QA timeout');app.exit(1)},45000)
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{preload:path.join(root,'tests/renderer/fixtures/settings-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}})
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!message.includes('QA disk write failed'))errors.push(message)})
    await win.loadFile(path.join(root,'out/renderer/index.html'),{hash:'/api-keys'})
    await waitFor("document.getElementById('global-enable')&&!document.getElementById('global-enable').disabled",'keys ready')
    await js('window.settingsQA.failSave(true)')
    await click("document.getElementById('global-enable')")
    await waitFor("document.body.textContent.includes('QA disk write failed')&&!document.getElementById('global-enable').disabled",'failure visible')
    assert.equal(await js("document.getElementById('global-enable').getAttribute('aria-checked')"),'false')
    assert.equal((await js('window.settingsQA.snapshot()')).config.enableApiKey,false)
    results.push('Failed save preserves authentication and shows an error')
    await js('window.settingsQA.failSave(false)')
    await click("document.getElementById('global-enable')")
    await waitFor("document.getElementById('global-enable').getAttribute('aria-checked')==='true'",'auth enabled')
    await click(control(labels.apiKeys.newApiKey))
    await waitFor("!!document.getElementById('key-name')",'new key dialog')
    await js("(()=>{const el=document.getElementById('key-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'QA key');el.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await click(control(labels.apiKeys.create,'[role=dialog] button'))
    await waitFor("!document.querySelector('[role=dialog]')",'key saved')
    assert.match((await js('window.settingsQA.snapshot()')).config.apiKeys[0].key,/^sk-[0-9a-f]{64}$/)
    results.push('Successful save updates the view and new keys have the secure format')
    await js("location.hash='#/settings'")
    await waitFor(`!!(${control(labels.settings.generalSettings,'[role=tab]')})`,'settings ready')
    await waitFor("!!document.getElementById('ui-font-size')",'typography settings ready')
    assert.equal(await js("getComputedStyle(document.documentElement).fontSize"),'18px')
    assert.deepEqual(await js("[...document.querySelectorAll('.sidebar-nav-item')].slice(0,2).map(link=>link.getAttribute('href'))"), ['#/', '#/chat'])
    await click("document.getElementById('ui-font-size')")
    await click(control('22 px','[role=option]'))
    await waitFor("window.settingsQA.snapshot().config.uiTypography?.fontSize===22 && getComputedStyle(document.documentElement).fontSize==='22px'",'font size applies and saves')
    await click("document.getElementById('ui-font-weight')")
    await click(control(labels.settings.fontMedium,'[role=option]'))
    await waitFor("window.settingsQA.snapshot().config.uiTypography?.fontWeight===500 && getComputedStyle(document.body).fontWeight==='500'",'font weight applies and saves')
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload()})
    await waitFor("document.getElementById('ui-font-size') && getComputedStyle(document.documentElement).fontSize==='22px'",'font settings survive restart')
    assert.equal(await js("getComputedStyle(document.body).fontWeight"),'500')
    assert.equal(await js("document.documentElement.scrollWidth<=window.innerWidth+1"), true)
    await js("document.getElementById('ui-font-size').scrollIntoView({block:'center'})")
    await delay(250)
    assert.equal(await js("getComputedStyle(document.querySelector('[data-typography-preview] p')).color===getComputedStyle(document.documentElement).color"),true,'Preview and inherited text must match the active theme')
    fs.writeFileSync(path.join(output,'typography-settings.png'),(await win.webContents.capturePage()).toPNG())
    await click(control(labels.settings.fontReset))
    await waitFor("getComputedStyle(document.documentElement).fontSize==='18px' && window.settingsQA.snapshot().config.uiTypography?.fontWeight===400",'restore default font')
    results.push('Larger readable text is the default; size and weight save, apply and survive reload; AI Chat follows Companion in navigation')
    await click(control(labels.settings.generalSettings,'[role=tab]'))
    await click("document.getElementById('minimize-tray')")
    await waitFor("window.settingsQA.snapshot().config.minimizeToTray===false",'tray saved')
    results.push('Tray setting reaches application configuration')
    await click(control(labels.settings.data,'[role=tab]'))
    assert.deepEqual(await database(true),{conversations:1,summaries:1,metadata:1})
    await click(control(labels.settings.resetApp))
    await waitFor("!!document.querySelector('[role=dialog]')",'reset dialog')
    await click(control(labels.common.cancel,'[role=dialog] button'))
    await waitFor("!document.querySelector('[role=dialog]')",'cancelled')
    assert.deepEqual(await database(),{conversations:1,summaries:1,metadata:1})
    assert.equal((await js('window.settingsQA.snapshot()')).calls.includes('clear'),false)
    results.push('Cancel closes the reset dialog and preserves history')
    await click(control(labels.settings.resetApp))
    await click(control(labels.settings.confirmReset,'[role=dialog] button'))
    await waitFor("window.settingsQA.snapshot().calls.includes('clear')",'reset completed')
    const state=await js('window.settingsQA.snapshot()')
    assert.equal(state.running,false)
    assert.ok(state.calls.indexOf('stop')<state.calls.indexOf('clear'))
    assert.deepEqual(await database(),{conversations:0,summaries:0,metadata:0})
    results.push('Reset stops the proxy before clearing application and IndexedDB data')
    await delay(1800)
    assert.deepEqual(await database(),{conversations:0,summaries:0,metadata:0})
    results.push('Reload does not restore reset history')
    assert.deepEqual(errors,[])
    const result=JSON.stringify({results,errors},null,2)
    fs.writeFileSync(path.join(output,'settings-ui-results.json'),result)
    console.log(result)
    clearTimeout(timeout);win.destroy();app.exit(0)
  }catch(error){
    console.error(error)
    if(win)console.error(await js('document.body.innerText').catch(()=>'Page unavailable'))
    clearTimeout(timeout);app.exit(1)
  }
})
