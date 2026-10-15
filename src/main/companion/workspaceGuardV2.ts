import path from 'node:path'
import { mkdir, realpath, lstat, writeFile } from 'node:fs/promises'
import type { WorkspaceGrant } from '../../shared/companion'

export const OPENCODE_V2_GUARD_ID = 'dailyworkmate-workspace-guard-v2'

/** Self-contained official V2 Promise plugin, loaded only from our isolated runtime directory. */
export function workspaceGuardV2Source(grants: WorkspaceGrant[], directory: string, allowShell = true): string {
  return 'const grants = ' + JSON.stringify(grants.map(({ path, writable }) => ({ path, writable }))) + ';\nconst directory = ' + JSON.stringify(directory) + ';\nconst allowShell = ' + JSON.stringify(allowShell) + ';\n' + String.raw`
import path from 'node:path'
import { realpath, lstat, readdir, readFile } from 'node:fs/promises'
const denied = message => { throw new Error('Workspace guard: ' + message) }
const within = (root, target) => { const r = path.relative(root, target); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)) }
const secret = file => file.split(/[\\/]/).some(part => /(?:^|\.)env(?:\.|$)|credentials|\.(?:pem|key)$|^\.(?:ssh|aws|gnupg)$/i.test(part))
const safePath = file => {
  if (typeof file !== 'string' || !file || /[\0-\x1f]/.test(file)) denied('invalid file path')
  if (file.replace(/^[A-Za-z]:[\\/]/, '').includes(':') || /^[\\/]{2}[?.]/.test(file)) denied('device paths and alternate streams are denied')
  return file
}
async function canonical(target) {
  try { return await realpath(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const entry = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (entry?.isSymbolicLink()) denied('dangling link denied')
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await canonical(parent), path.basename(target))
  }
}
async function check(file, write = false) {
  const lexical = path.resolve(directory, safePath(file))
  const target = await canonical(lexical)
  if (secret(lexical) || secret(target)) denied('sensitive file access denied')
  const matching = grants.filter(grant => within(grant.path, lexical) && within(grant.path, target)).sort((a, b) => b.path.length - a.path.length)
  const grant = matching[0]
  if (!grant || (write && !grant.writable)) denied('path is outside an authorized ' + (write ? 'writable' : 'readable') + ' folder')
  if (path.relative(await realpath(grant.path), grant.path) !== '') denied('authorized folder target changed')
  return target
}
async function checkInstructions(target) {
  const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  let parent = info?.isDirectory() ? target : path.dirname(target)
  while (within(directory, parent)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(parent, name)
      if (await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })) await check(file)
    }
    if (path.relative(directory, parent) === '') break
    parent = path.dirname(parent)
  }
}
// Replace native recursive search: it does not check each file's authorization.
// Protected files and links are skipped before opening them; large results are explicit.
function globMatch(file, pattern) {
  const alternatives = [pattern]
  for (let i = 0; i < alternatives.length; i++) {
    const match = alternatives[i].match(/\{([^{}]+)\}/)
    if (!match) continue
    const base = alternatives.splice(i, 1)[0]
    alternatives.push(...match[1].split(',').map(part => base.replace(match[0], part))); i--
    if (alternatives.length > 32) denied('glob has too many alternatives')
  }
  return alternatives.some(pattern => {
    let regex = '^'
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i]
      if (char === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; regex += '(?:.*/)?' } else regex += '.*' }
      else if (char === '*') regex += '[^/]*'
      else if (char === '?') regex += '[^/]'
      else regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
    return new RegExp(regex + '$').test(file) || (!pattern.includes('/') && new RegExp(regex + '$').test(path.basename(file)))
  })
}
async function search(tool, args) {
  const root = await check(args.path || directory), pending = [root], matches = []
  const limit = Math.min(1000, Math.max(1, args.limit || 100)), deadline = Date.now() + 10000
  let count = 0, truncated = false
  const pattern = args.pattern
  if (typeof pattern !== 'string' || !pattern || pattern.length > 512) denied('invalid search pattern')
  if (tool === 'glob' && (/[\0-\x1f:]/.test(pattern) || path.isAbsolute(pattern) || pattern.includes('..'))) denied('glob pattern must stay inside its search folder')
  // Avoid regex forms with unbounded backtracking; literal searches accept all text.
  if (tool === 'grep' && !args.literal && (/\)[*+{]|\\[1-9]|\(\?[=!<]|(?:\.\*){2}/.test(pattern))) denied('use literal search or a simple regular expression')
  const regex = tool === 'grep' && !args.literal ? new RegExp(pattern, args.caseSensitive === false ? 'i' : '') : null
  while (pending.length) {
    if (++count > 50000 || Date.now() > deadline || matches.length >= limit) { truncated = true; break }
    const file = pending.pop()
    if (secret(file)) continue
    const info = await lstat(file)
    if (info.isSymbolicLink()) continue
    try { await check(file) } catch { continue }
    if (info.isDirectory()) {
      for (const item of await readdir(file, { withFileTypes: true })) {
        if (['node_modules', '.git', '.cache', 'dist', 'build'].includes(item.name) || (!args.hidden && item.name.startsWith('.')) || secret(item.name) || item.isSymbolicLink()) continue
        pending.push(path.join(file, item.name))
      }
      continue
    }
    if (!info.isFile()) continue
    const relative = path.relative(root, file).replace(/\\/g, '/') || path.basename(file)
    if (tool === 'glob') { if (globMatch(relative, pattern)) matches.push(file); continue }
    if (args.include && !globMatch(relative, args.include)) continue
    if (info.size > 2 * 1024 * 1024) continue
    const bytes = await readFile(file)
    if (bytes.includes(0)) continue
    const lines = bytes.toString('utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length && matches.length < limit; index++) {
      const line = lines[index].slice(0, 4000)
      const literal = args.caseSensitive === false ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern)
      if (regex ? regex.test(line) : literal) matches.push(file + ':' + (index + 1) + ': ' + line)
    }
  }
  return { content: (matches.join('\n') || 'No matches found') + (truncated ? '\nResults truncated. Narrow the search path or pattern.' : ''), metadata: { count: matches.length, truncated } }
}
export default {
  id: 'dailyworkmate-workspace-guard-v2',
  async setup(ctx) {
    if (!ctx.location || path.relative(directory, await realpath(ctx.location.directory)) !== '') denied('runtime location does not match the authorized workspace')
    const providerID = ctx.options?.providerID
    const modelID = ctx.options?.modelID
    if (!['dailyworkmate', 'opencode'].includes(providerID) || typeof modelID !== 'string' || !modelID) denied('selected model binding is missing')
    // Other authorized drives may be offline; validate their canonical target only on access.
    await ctx.model.transform(editor => { for (const model of editor.list()) if (model.providerID !== providerID || model.id !== modelID) editor.remove(model.providerID, model.id) })
    await ctx.session.hook('model.request', event => {
      if (event.model.providerID !== providerID || event.model.id !== modelID) denied('unselected model request denied')
    })
    await ctx.tool.transform(editor => {
      for (const name of ['glob', 'grep']) editor.update(name, tool => {
        tool.output = undefined
        tool.execute = args => search(name, args)
      })
    })
    await ctx.tool.hook('execute.before', async event => {
      const args = event.input
      if (!args || typeof args !== 'object' || Array.isArray(args)) denied('invalid tool arguments')
      if (['read', 'write', 'edit'].includes(event.tool)) {
        const target = await check(args.path, event.tool !== 'read')
        if (event.tool === 'read') {
          // Do not let the native reader guess an alternate filename we did not validate.
          await lstat(target)
          await checkInstructions(target)
        }
        event.input = { ...args, path: target }
      } else if (['glob', 'grep'].includes(event.tool)) {
        const target = await check(args.path || directory)
        if (event.tool === 'glob' && (typeof args.pattern !== 'string' || /[\0-\x1f:]/.test(args.pattern) || path.isAbsolute(args.pattern) || args.pattern.includes('..'))) denied('glob pattern must stay inside its search folder')
        event.input = { ...args, path: target }
      } else if (event.tool === 'patch') {
        if (typeof args.patchText !== 'string') denied('invalid patch')
        const files = [...args.patchText.matchAll(/^[*][*][*] (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1].trim())
        if (!files.length) denied('patch has no recognized file paths')
        for (const file of files) await check(file, true)
      } else if (event.tool === 'shell') {
        if (!allowShell) denied('commands are disabled for a restricted folder scope; use file tools')
        const current = grants.filter(grant => within(grant.path, directory)).sort((a, b) => b.path.length - a.path.length)[0]
        if (!current?.writable) denied('commands are disabled in a read-only workspace')
        const target = await check(args.workdir || directory, true)
        if (typeof args.command !== 'string' || !args.command.trim()) denied('invalid command')
        if (args.background) denied('background commands are disabled')
        event.input = { ...args, workdir: target, timeout: Math.min(typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 120000, 120000) }
        // The native shell scanner applies the configured command permission after these checks.
      } else if (!['todowrite', 'todoread', 'todo'].includes(event.tool)) denied('unsupported tool ' + event.tool)
    })
  },
}
`
}

export async function installWorkspaceGuardV2(guardDirectory: string, grants: WorkspaceGrant[], directory: string, allowShell = true): Promise<void> {
  if (!path.isAbsolute(guardDirectory) || !path.isAbsolute(directory) || !grants.length) throw new Error('Invalid managed OpenCode V2 workspace')
  if (path.relative(await realpath(directory), directory) !== '') throw new Error('Workspace target changed')
  for (const grant of grants) {
    if (!path.isAbsolute(grant.path) || typeof grant.writable !== 'boolean') throw new Error('Invalid workspace authorization')
  }
  await mkdir(guardDirectory, { recursive: true })
  if (path.relative(await realpath(guardDirectory), guardDirectory) !== '') throw new Error('Managed OpenCode guard directory target changed')
  for (const file of ['package.json', 'index.js']) {
    const entry = await lstat(path.join(guardDirectory, file)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (entry && !entry.isFile()) throw new Error('Managed OpenCode guard file target changed')
  }
  await writeFile(path.join(guardDirectory, 'package.json'), JSON.stringify({ name: OPENCODE_V2_GUARD_ID, version: '1.0.0', type: 'module', exports: { '.': './index.js' } }), 'utf8')
  await writeFile(path.join(guardDirectory, 'index.js'), workspaceGuardV2Source(grants, directory, allowShell), 'utf8')
}
