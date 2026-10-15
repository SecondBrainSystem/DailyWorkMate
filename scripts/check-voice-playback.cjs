// Isolated React playback QA. Audio/IPC are deterministic doubles; no account data or model requests.
const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'tmp', 'qa', 'voice-playback-' + process.pid)
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'))
const entry = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {useVoice} from './src/renderer/src/components/companion/useVoice.ts';
import {DEFAULT_COMPANION_SETTINGS} from './src/shared/companion.ts';
import {companionCopy} from './src/renderer/src/components/companion/copy.ts';
const qa=window.qa={calls:[],plays:[],audios:[],contexts:[],errors:[],jobs:[],cancelWaits:[],cancelCount:0,warmups:0,holdSynthesis:false,holdAfter:Infinity,holdCancel:false,holdResume:false,autoEnd:true,fetchCount:0,summaryController:null};
let urlSerial=0;const blobs=new Map();URL.createObjectURL=blob=>{const url='blob:qa-'+(++urlSerial);blobs.set(url,blob);return url};URL.revokeObjectURL=url=>blobs.delete(url);
window.Audio=class { constructor(url){this.url=url;this.paused=true;this.volume=1;qa.audios.push(this)} async play(){this.paused=false;const text=new TextDecoder().decode(await blobs.get(this.url).arrayBuffer());if(this.paused)return;this.text=text;qa.plays.push(text);qa.activeAudio=this;if(qa.autoEnd)setTimeout(()=>{if(!this.paused)this.onended?.()},1)}pause(){this.paused=true} };
window.AudioContext=class { constructor(){this.state='suspended';qa.contexts.push(this);this.hold=qa.holdResume;qa.holdResume=false}createAnalyser(){return {fftSize:256,getFloatTimeDomainData:v=>v.fill(0),connect(){}}}createMediaElementSource(){return {connect(){}}}async resume(){if(this.hold)await new Promise(resolve=>{this.release=resolve});if(this.state!=='closed')this.state='running'}async close(){this.state='closed'}get destination(){return {}} };
Object.defineProperty(window,'speechSynthesis',{value:{cancel(){},getVoices:()=>[],speak(){throw Error('Unexpected system fallback')}}});
window.electronAPI={config:{get:async()=>({proxyHost:'127.0.0.1',proxyPort:9999,enableApiKey:false})},companion:{warmupSpeech:async()=>{qa.warmups++;return {ready:true}},cancelSpeech:async()=>{qa.cancelCount++;if(qa.holdCancel)await new Promise(resolve=>qa.cancelWaits.push(resolve))},synthesize:text=>{const entry={text};qa.calls.push(entry);const result={audio:new TextEncoder().encode(text),mime:'audio/wav',notice:qa.resultNotice};if(qa.holdSynthesis||qa.calls.length>qa.holdAfter)return new Promise(resolve=>entry.release=()=>resolve(result));return Promise.resolve(result)}}};
window.fetch=async()=>{qa.fetchCount++;const first='首先确认当前处理已经完成，后续仍需要核对',tail='所有必要的检查步骤。';qa.summaryText=first+tail;const encoder=new TextEncoder();const event=content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\\n\\n';return new Response(new ReadableStream({start(controller){qa.summaryController=controller;controller.enqueue(encoder.encode(event(first)));qa.releaseSummary=()=>{controller.enqueue(encoder.encode(event(tail)+'data: [DONE]\\n\\n'));controller.close()}}}))};
function Harness(){const voice=useVoice({...DEFAULT_COMPANION_SETTINGS,autoSpeak:false,systemFallback:false,ttsMode:'local'},companionCopy.zh,()=>{},message=>qa.errors.push(message));qa.voice=voice;qa.state={speaking:voice.speaking,notice:voice.notice};window.read=(text,mode='full',model='qa-model')=>{const job={done:false};qa.jobs.push(job);void voice.speak(text,mode,model).finally(()=>job.done=true)};window.stopReading=()=>voice.stop();return <div><span id='state'>{voice.speaking?'speaking':'idle'}</span><span id='notice'>{voice.notice}</span></div>}
createRoot(document.querySelector('#root')).render(<React.StrictMode><Harness/></React.StrictMode>);`
const bundled = build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},outfile:path.join(output,'qa.js'),bundle:true,platform:'browser',format:'iife',alias:{'@':path.join(root,'src/renderer/src'),'@shared':path.join(root,'src/shared')}})
fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="qa.js"></script>')
let window
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)), js=code=>window.webContents.executeJavaScript(code,true)
async function until(code){for(let i=0;i<250;i++){if(await js(code))return;await wait(20)}throw Error('Timeout: '+code)}
async function reset(){await js('qa.calls=[];qa.plays=[];qa.audios=[];qa.contexts=[];qa.jobs=[];qa.cancelWaits=[];qa.cancelCount=0;qa.holdSynthesis=false;qa.holdAfter=Infinity;qa.holdCancel=false;qa.holdResume=false;qa.autoEnd=true;qa.resultNotice=undefined;');}
app.whenReady().then(async()=>{
  await bundled
  window=new BrowserWindow({show:false,width:600,height:300,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const network=[];window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url))network.push(details.url);callback({cancel:/^https?:/.test(details.url)})})
  await window.loadFile(path.join(output,'index.html'));await until('!!window.qa?.voice')
  assert.ok(await js('qa.warmups>=1'));assert.equal(await js('qa.cancelCount'),0,'idle StrictMode cleanup must preserve warmup')

  // One short first phrase, then at most one prefetched phrase until playback advances.
  const original='先确认这次修改已经完成，'+'后面的内容需要逐项核对并完整读出'.repeat(10)+'。最后一句也必须保留🐙。'
  await js('qa.autoEnd=false;window.read('+JSON.stringify(original)+')');await until('qa.plays.length===1&&qa.calls.length===2')
  assert.ok(await js('[...qa.calls[0].text].length<=18'));await wait(40);assert.equal(await js('qa.calls.length'),2)
  await js('qa.autoEnd=true;qa.activeAudio.onended()');await until('qa.jobs.every(job=>job.done)&&!qa.state.speaking')
  assert.equal(await js('qa.plays.join("")'),original)

  // A replacement waits for async cancellation; a late old synthesis never plays.
  await reset();await js('qa.holdSynthesis=true;qa.holdCancel=true;window.read("旧回复必须被丢弃。")');await until('qa.calls.length===1')
  await js('window.read("新的回复开始朗读。")');await until('qa.cancelCount===1');assert.equal(await js('qa.calls.length'),1)
  await js('qa.calls[0].release()');await wait(30);assert.equal(await js('qa.plays.length'),0)
  await js('qa.holdSynthesis=false;qa.holdCancel=false;qa.cancelWaits[0]()');await until('qa.jobs.every(job=>job.done)')
  assert.deepEqual(await js('qa.plays'),['新的回复开始朗读。'])

  // Stop + immediate replacement also waits for cancellation, despite no previous controller.
  await reset();await js('qa.autoEnd=false;qa.holdAfter=1;window.read('+JSON.stringify(original)+')');await until('qa.plays.length===1&&qa.calls.length===2')
  await js('qa.holdCancel=true;window.stopReading();qa.holdAfter=Infinity;window.read("另一条回复保持播放。")');await until('qa.cancelCount===1');assert.equal(await js('qa.calls.length'),2)
  await js('qa.holdCancel=false;qa.cancelWaits[0]()');await until('qa.plays.length===2')
  await js('qa.calls[1].release();qa.audios[0].onended?.()');await wait(30)
  assert.equal(await js('qa.activeAudio.text'), '另一条回复保持播放。');assert.equal(await js('qa.activeAudio.paused'),false);assert.equal(await js('qa.state.speaking'),true)
  await js('qa.activeAudio.onended()');await until('qa.jobs.every(job=>job.done)')

  // Late AudioContext.resume/finally from an old reply cannot close or pause the new one.
  await reset();await js('qa.autoEnd=false;qa.holdResume=true;window.read("等待旧音频上下文。")');await until('qa.contexts.length===1&&!!qa.contexts[0].release')
  await js('window.read("新音频仍然正确播放。")');await until('qa.plays.length===1')
  await js('qa.contexts[0].release()');await wait(30)
  assert.deepEqual(await js('qa.plays'),['新音频仍然正确播放。']);assert.equal(await js('qa.activeAudio.paused'),false);assert.equal(await js('qa.contexts[1].state'),'running')
  await js('qa.activeAudio.onended()');await until('qa.jobs.every(job=>job.done)')

  // Real Hook consumes a streamed summary prefix once, then reuses the completed summary cache.
  await reset();const longReply='这是需要真正归纳总结的完整模型回复。'.repeat(30)
  await js('window.read('+JSON.stringify(longReply)+',"summary")');await until('qa.calls.length===1&&!!qa.releaseSummary')
  assert.equal(await js('qa.plays.length'),0,'do not speak an uncompleted or failed summary')
  await js('qa.releaseSummary()');await until('qa.jobs.every(job=>job.done)')
  assert.equal(await js('qa.plays.join("")'),await js('qa.summaryText'))
  const fetches=await js('qa.fetchCount');await reset();await js('window.read('+JSON.stringify(longReply)+',"summary")');await until('qa.jobs.every(job=>job.done)')
  assert.equal(await js('qa.fetchCount'),fetches);assert.equal(await js('qa.plays.join("")'),await js('qa.summaryText'))

  await reset();await js('qa.autoEnd=false;qa.resultNotice="QA_LOCAL_ENGINE_FALLBACK";window.read("这一句检查提示信息。")');await until('qa.plays.length===1')
  assert.equal(await js('qa.state.notice'),'QA_LOCAL_ENGINE_FALLBACK');await js('qa.activeAudio.onended()');await until('qa.jobs.every(job=>job.done)')
  assert.deepEqual(await js('qa.errors'),[]);assert.deepEqual(network,[])
  console.log(JSON.stringify({passed:true,shortFirstPhrase:true,onePhrasePrefetch:true,fullTextPreserved:true,cancelBarrier:true,lateSynthesisIgnored:true,latePlaybackCleanupIsolated:true,summaryOverlap:true,summaryCache:true,idleWarmupPreserved:true,engineNotice:true,externalRequests:0}))
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{window?.destroy();app.quit()})
