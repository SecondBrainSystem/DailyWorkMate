import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
const require = createRequire(import.meta.url)
let api
before(async () => {
  await mkdir('tmp/qa', {recursive:true})
  const outfile = path.resolve('tmp/qa/usage-monitor-' + process.pid + '.cjs')
  await build({stdin:{contents:"export * from './src/renderer/src/lib/usageMetrics'; export * from './src/renderer/src/stores/dashboardStore'",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'cjs',packages:'external'})
  api = require(outfile)
})
test('a selected period excludes lifetime and future usage and compares the preceding equal period', () => {
  const snapshot={totalTokens:999999,dailyStatsAvailableFrom:'2026-09-01',dailyStats:{
    '2026-10-22':{totalTokens:120,totalRequests:3,successRequests:2,failedRequests:1,totalLatency:4000,modelTokenUsage:{alpha:100,beta:20},modelUsage:{alpha:2,beta:1}},
    '2026-10-16':{totalTokens:80,totalRequests:1,successRequests:1,totalLatency:2000,modelTokenUsage:{alpha:80}},
    '2026-10-15':{totalTokens:100},
    '2026-10-23':{totalTokens:9000},
  }}
  const before=structuredClone(snapshot)
  const result=api.summarizeUsage(snapshot,7,new Date(2026,9,22,0,1))
  assert.equal(result.totalTokens,200);assert.equal(result.totalRequests,4)
  assert.equal(result.previousTokens,100);assert.equal(result.tokenChange,100)
  assert.equal(result.successRate,75);assert.equal(result.avgLatency,2000)
  assert.equal(result.models[0].tokens,180);assert.equal(result.activeDays,2)
  assert.equal(result.peak.date,'2026-10-22');assert.deepEqual(snapshot,before)
})
test('empty, unreported and malformed historic fields stay honest', () => {
  const empty=api.summarizeUsage(null,30,new Date(2026,9,22))
  assert.equal(empty.successRate,null);assert.equal(empty.tokenChange,null);assert.equal(empty.avgLatency,null)
  const result=api.summarizeUsage({dailyStats:{'2026-10-22':{totalRequests:1,successRequests:1,modelUsage:{legacy:1}},'2026-10-21':{totalTokens:-1,totalRequests:NaN,modelTokenUsage:{bad:Infinity}}}},7,new Date(2026,9,22))
  assert.equal(result.totalTokens,0);assert.equal(result.totalRequests,1)
  assert.deepEqual(result.models,[{model:'legacy',tokens:0,requests:1}])
  assert.equal(result.peak,null)
})
test('calendar days cross month, year and DST boundaries without UTC date shifts', () => {
  for(const date of [new Date(2026,0,2),new Date(2026,2,30),new Date(2026,9,26)]) {
    const days=api.usageDays(null,7,date)
    assert.equal(new Set(days.map(day=>day.date)).size,7)
    assert.equal(days.at(-1).date,date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'))
  }
  assert.equal(api.usageDays(null,7,new Date(2026,0,2))[0].date,'2025-12-27')
})

test('pruned history cannot produce a fabricated 2900 percent increase or zero-filled averages', () => {
  const dailyStats=Object.fromEntries(Array.from({length:31},(_,index)=>{
    const date=new Date(2026,9,22-index,12)
    const key=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')
    return [key,{totalTokens:100,totalRequests:1}]
  }))
  const snapshot={dailyStatsAvailableFrom:'2026-10-22',dailyStats}
  const month=api.summarizeUsage(snapshot,30,new Date(2026,9,22))
  assert.equal(month.totalTokens,3000);assert.equal(month.previousTokens,100)
  assert.equal(month.complete,true);assert.equal(month.canCompare,false);assert.equal(month.tokenChange,null)
  const quarter=api.summarizeUsage(snapshot,90,new Date(2026,9,22))
  assert.equal(quarter.availableDays,31);assert.equal(quarter.complete,false)
  assert.equal(quarter.totalTokens,3100);assert.equal(quarter.dailyAverage,100)
  assert.equal(api.usageDays(snapshot,91,new Date(2026,9,22)).filter(day=>!day.available).length,60)
})

test('coverage distinguishes a known idle day from unavailable legacy history', () => {
  const snapshot={dailyStatsAvailableFrom:'2026-10-20',dailyStats:{'2026-10-18':{totalTokens:50}}}
  const days=api.usageDays(snapshot,5,new Date(2026,9,22))
  assert.deepEqual(days.map(day=>[day.available,day.tokens]),[[true,50],[false,0],[true,0],[true,0],[true,0]])
  const idle=api.summarizeUsage({dailyStatsAvailableFrom:'2026-09-01',dailyStats:{}},7,new Date(2026,9,22))
  assert.equal(idle.complete,true);assert.equal(idle.canCompare,true);assert.equal(idle.dailyAverage,0)
  const unavailable=api.summarizeUsage({dailyStats:{}},7,new Date(2026,9,22))
  assert.equal(unavailable.availableDays,0);assert.equal(unavailable.dailyAverage,null)
})

test('180 retained days support a complete 90-day comparison with stable daily usage', () => {
  const rows=api.usageDays(null,180,new Date(2026,9,22))
  const snapshot={dailyStatsAvailableFrom:rows[0].date,dailyStats:Object.fromEntries(rows.map(day=>[day.date,{totalTokens:100}]))}
  for(const length of [7,30,90]) {
    const summary=api.summarizeUsage(snapshot,length,new Date(2026,9,22))
    assert.equal(summary.totalTokens,length*100);assert.equal(summary.previousTokens,length*100)
    assert.equal(summary.canCompare,true);assert.equal(summary.tokenChange,0)
  }
  assert.equal(api.usageDays(snapshot,91,new Date(2026,9,22)).every(day=>day.available),true)
})
test('polling coalesces overlapping calls, keeps stale data, and recovers', async () => {
  const store=api.useDashboardStore
  let calls=0, release
  globalThis.window={electronAPI:{statistics:{get:()=>{calls++;return new Promise(resolve=>{release=resolve})}},requestLogs:{get:async()=>[]}}}
  const first=store.getState().refreshData(), second=store.getState().refreshData()
  assert.equal(calls,1);assert.equal(first,second)
  release({totalTokens:200,dailyStats:{}})
  await first
  const updated=store.getState().lastUpdated
  window.electronAPI.statistics.get=async()=>{throw new Error('offline')}
  await store.getState().refreshData()
  assert.equal(store.getState().snapshot.totalTokens,200)
  assert.equal(store.getState().lastUpdated,updated);assert.equal(store.getState().error,'offline')
  window.electronAPI.statistics.get=async()=>({totalTokens:300,dailyStats:{}})
  window.electronAPI.requestLogs.get=async()=>{throw new Error('logs unavailable')}
  await store.getState().refreshData()
  assert.equal(store.getState().snapshot.totalTokens,300)
  assert.equal(store.getState().error,null);assert.equal(store.getState().activityError,'logs unavailable')
  assert.equal(store.getState().isLoading,false)
})
