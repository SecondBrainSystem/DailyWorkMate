import type { WorkspaceGrant } from '../../shared/companion'

/** A dependency-free OpenCode hook. Kept as source so the managed runtime can load it. */
export function workspaceGuardSource(grants: WorkspaceGrant[], directory: string): string {
  return 'const grants = ' + JSON.stringify(grants) + ';\nconst directory = ' + JSON.stringify(directory) + ';\n' + String.raw`
import path from 'node:path'
import { realpath, lstat } from 'node:fs/promises'
const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
async function canonical(target) {
  try { return await realpath(target) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A dangling link is not a new file: it must never be followed by a writer.
    const link = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (link?.isSymbolicLink()) throw new Error('Workspace guard: dangling link denied')
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await canonical(parent), path.basename(target))
  }
}
async function check(file, write) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Workspace guard: invalid file path')
  const lexical = path.resolve(directory, file)
  const target = await canonical(lexical)
  const matching = grants.filter(grant => within(grant.path, lexical) && within(grant.path, target)).sort((a, b) => b.path.length - a.path.length)
  const grant = matching[0]
  if (!grant || (write && !grant.writable)) throw new Error('Workspace guard: file is outside an authorized ' + (write ? 'writable' : 'readable') + ' folder')
  if (path.relative(await realpath(grant.path), grant.path) !== '') throw new Error('Workspace guard: authorized folder target changed')
  return target
}
export default async () => ({
  'tool.execute.before': async (input, output) => {
    const args = output.args || {}
    if (['read', 'write', 'edit'].includes(input.tool)) {
      const filePath = await check(args.filePath, input.tool !== 'read')
      output.args = { ...args, filePath }
    } else if (['glob', 'grep', 'list'].includes(input.tool)) {
      const target = await check(args.path || directory, false)
      output.args = { ...args, path: target }
    } else if (input.tool === 'apply_patch') {
      if (typeof args.patchText !== 'string') throw new Error('Workspace guard: invalid patch')
      const files = [...args.patchText.matchAll(/^[*][*][*] (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1].trim())
      if (!files.length) throw new Error('Workspace guard: patch has no recognized file paths')
      for (const file of files) await check(file, true)
    } else if (!['bash', 'todowrite', 'todoread'].includes(input.tool)) {
      throw new Error('Workspace guard: unsupported tool ' + input.tool)
    }
  },
})
`
}
