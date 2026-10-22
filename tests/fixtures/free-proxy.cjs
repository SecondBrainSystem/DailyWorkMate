// Real public middleware, routes and transports; only Electron UI/storage and management are isolated.
const { build } = require('esbuild')
const path = require('node:path')
const fs = require('node:fs/promises')
const http = require('node:http')
const crypto = require('node:crypto')

exports.startFreeProxy = async function (directory, port = 0) {
  await fs.mkdir(directory, { recursive: true })
  const outfile = path.join(directory, 'proxy.cjs')
  await build({
    stdin: { contents: `export { ProxyServer } from './src/main/proxy/server.ts';
      export { state } from './src/main/store/store';
      export { KiloFreeModelCatalogue } from './src/main/inference/kiloModels.ts';
      export { OpenCodeFreeModelCatalogue } from './src/main/companion/opencodeModels.ts';
      export { listFreeRoutingModels } from './src/main/inference/modelListing.ts';
      export { testOllamaRouting } from './src/main/ollama/routingTest.ts';
      export { proxyStatusManager } from './src/main/proxy/status.ts';`, resolveDir: process.cwd() },
    outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'isolate-public-free-proxy', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$|^\.\/routes\/management$)/ }, args => ({
        path: args.path === 'electron' ? 'electron' : args.path.endsWith('/management') ? 'management' : 'store', namespace: 'qa',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ resolveDir: process.cwd(), contents: {
        electron: `export const app = {isPackaged:false,getVersion:()=> 'QA'}; export const net = {}; export const shell = {}; export const BrowserWindow = { getAllWindows:()=>[] };`,
        management: 'export default []',
        store: `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
          export const state = { config:{...DEFAULT_CONFIG, enableApiKey:true,apiKeys:[],retryCount:0,
            ollamaRouting:{forceModel:false,model:'',providerId:'',autoSelectUrl:false}},
            providers:[],accounts:[],logs:[],requests:[],stats:[],tokens:[],keyUses:[] };
          export const storeManager = {
            getConfig:()=>state.config,getSessionConfig:()=>DEFAULT_CONFIG.sessionConfig,
            getProviders:()=>state.providers,getEffectiveModels:id=>(state.providers.find(p=>p.id===id)?.supportedModels||[]).map(id=>({displayName:id,actualModelId:id})),
            getAccountsByProviderId:id=>state.accounts.filter(a=>a.providerId===id),
            recordApiKeyUsage:id=>{state.keyUses=[...state.keyUses,id]},
            recordRequestInStats:(...args)=>{state.stats=[...state.stats,args]},recordTokenUsage:(...args)=>{state.tokens=[...state.tokens,args]},
            addLog:(...args)=>{state.logs=[...state.logs,args]},
            addRequestLog:log=>{const entry={...log,id:String(state.requests.length)};state.requests=[...state.requests,entry];return entry},
            updateRequestLog:(id,updates)=>{state.requests=state.requests.map(log=>log.id===id?{...log,...updates}:log)},
          };`,
      }[args.path] }))
    } }],
  })
  const api = require(outfile)
  const key = 'qa-' + crypto.randomBytes(24).toString('hex')
  api.state.config = { ...api.state.config, apiKeys: [{ id: 'qa', key, enabled: true }] }
  const server = http.createServer(new api.ProxyServer().app.callback())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { api, key, endpoint: 'http://127.0.0.1:' + server.address().port,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
