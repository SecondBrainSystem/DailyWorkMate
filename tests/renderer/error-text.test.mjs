import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const outfile = path.resolve('tmp/qa/error-text.mjs')
let ErrorText
before(async () => {
  await mkdir(path.dirname(outfile), {recursive:true})
  await build({ entryPoints:['src/renderer/src/components/ui/error-text.tsx'], outfile, bundle:true, platform:'node', format:'esm', packages:'external',
    plugins:[{name:'chinese-translation',setup(builder) {
      builder.onResolve({filter:/^react-i18next$/},()=>({path:'i18n',namespace:'qa'}))
      builder.onLoad({filter:/.*/,namespace:'qa'},()=>({resolveDir:process.cwd(),contents:`
        import zh from './src/renderer/src/i18n/locales/zh-CN.json';
        export const useTranslation=()=>({i18n:{language:'zh-CN'},t:key=>key.split('.').reduce((value,part)=>value[part],zh)});
      `}))
    }}],
  })
  ;({ErrorText} = await import(pathToFileURL(outfile)))
})
after(async () => { await rm(outfile,{force:true}) })

test('OpenCode free usage errors show a quota explanation and retain the original details', () => {
  const detail = 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go'
  const html = renderToStaticMarkup(createElement(ErrorText,{error:detail}))
  assert.match(html,/上游免费服务/)
  assert.ok(html.includes(detail))
  assert.ok(!html.includes('操作未完成'))
  assert.match(html,/<details/)
})

test('free service limits take priority over generic authentication errors and keep multiline details', () => {
  const detail = 'Kilo 免费通道受上游限流。 / Kilo free requests are rate limited by public IP.\nHTTP 403: upstream quota reached'
  const html = renderToStaticMarkup(createElement(ErrorText,{error:detail}))
  assert.match(html,/共享网络出口/)
  assert.match(html,/HTTP 403: upstream quota reached/)
  assert.ok(!html.includes('认证失败'))
})
