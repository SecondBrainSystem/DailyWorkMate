const { contextBridge } = require('electron')
localStorage.setItem('i18nextLng','zh-CN')
localStorage.setItem('dailyworkmate-settings',JSON.stringify({state:{theme:'dark',language:'zh-CN',sidebarCollapsed:false,sidebarHidden:false},version:0}))
const subscription=()=>()=>{}
let mode='normal'
let calls=0
let config={theme:'dark',language:'zh-CN',proxyPort:11434,proxyHost:'127.0.0.1',apiKeys:[],enableApiKey:false,modelMappings:{},loadBalanceStrategy:'round-robin',proxyListeners:[],modelFeatureDefaults:{vision:'auto',thinking:'auto'},ollamaRouting:{forceModel:false,routeOriginalModel:true},requestTimeout:120000,retryCount:3,sessionMode:'multi',maxRetries:3}
const names=['qwen3:32b','deepseek-v3','claude-sonnet','kilo-free/organization/a-model-with-a-very-long-name','gpt-4.1','glm-4.7','llama3.3:70b']
const days=Array.from({length:100},(_,i)=>{
  const date=new Date();date.setDate(date.getDate()-99+i)
  const key=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')
  const tokens=i%9===0?0:Math.floor((Math.sin(i*.72)+1.4)*34000+i*1300)
  const modelTokenUsage=Object.fromEntries(names.map((name,index)=>[name,Math.floor(tokens*(7-index)/28)]))
  const totalTokens=Object.values(modelTokenUsage).reduce((a,b)=>a+b,0)
  return {date:key,totalTokens,modelTokenUsage,totalRequests:totalTokens?28:0,successRequests:totalTokens?26:0,failedRequests:totalTokens?2:0,totalLatency:totalTokens?26*1250:0,modelUsage:Object.fromEntries(names.map((name,index)=>[name,totalTokens?7-index:0]))}
})
const logs=Array.from({length:7},(_,i)=>({id:'qa-request-'+i,timestamp:Date.now()-i*120000,status:i===2?'error':'success',statusCode:i===2?429:200,model:names[i],latency:1200+i*250,providerName:i%2?'Ollama':'API',method:'POST',url:'/v1/chat/completions',responseStatus:200,isStream:true,userInput:'QA request'}))
contextBridge.exposeInMainWorld('monitorQA',{setMode:value=>{mode=value},calls:()=>calls,total:n=>days.slice(-n).reduce((sum,day)=>sum+day.totalTokens,0)})
contextBridge.exposeInMainWorld('electronAPI',{
  config:{get:async()=>config,update:async updates=>{config={...config,...updates};return true},onConfigChanged:subscription},
  store:{get:async key=>key==='config'?config:[],set:async()=>{}},
  proxy:{getStatus:async()=>({isRunning:true,port:11434,host:'127.0.0.1',listeners:[]}),onStatusChanged:subscription,getStatistics:async()=>({})},
  statistics:{get:async()=>{
    calls++;await new Promise(r=>setTimeout(r,80));if(mode==='error')throw new Error('QA statistics offline')
    return {dailyStatsAvailableFrom:mode==='pruned'?days.at(-1).date:days[0].date,
      dailyStats:mode==='empty'?{}:Object.fromEntries((mode==='pruned'?days.slice(-31):days).map(day=>[day.date,day])),totalTokens:0}
  }},
  requestLogs:{get:async()=>mode==='empty'?[]:logs,getById:async id=>logs.find(log=>log.id===id),onNewLog:subscription},
  logs:{get:async()=>[],getStats:async()=>({}),onNewLog:subscription},
  providers:{getAll:async()=>[],getBuiltin:async()=>[],getStatus:async()=>({}),getAllStatus:async()=>({})},
  managementApi:{getConfig:async()=>({enableManagementApi:false,managementApiSecret:''})},
  accounts:{getAll:async()=>[]},
  ollama:{list:async()=>[],routingModels:async()=>({models:[],sources:[]})},
  app:{getVersion:async()=>'QA',getUpdateStatus:async()=>({}),onUpdateChecking:subscription,onUpdateAvailable:subscription,onUpdateNotAvailable:subscription,onUpdateProgress:subscription,onUpdateDownloaded:subscription,onUpdateError:subscription},
})
