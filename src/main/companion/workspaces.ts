import { realpath, stat, readdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceGrant, WorkspaceEntry } from '../../shared/companion'
import { boundedText } from '../../shared/companion.ts'

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

export async function resolveWorkspacePath(grant: WorkspaceGrant, relativePath: string): Promise<string> {
  boundedText(relativePath, 'relative path', 4096)
  if (path.isAbsolute(relativePath) || relativePath.includes(':') || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('Path must stay inside the authorized folder')
  }
  const root = await realpath(grant.path)
  // A replaced root symlink must not silently change the authorization target.
  if (path.relative(root, grant.path) !== '') throw new Error('Folder target changed; please authorize it again')
  const target = await realpath(path.resolve(root, relativePath))
  if (!isWithin(root, target)) throw new Error('This link points outside the authorized folder')
  return target
}

export async function listWorkspaceFiles(grant: WorkspaceGrant, relativePath: string): Promise<WorkspaceEntry[]> {
  const directory = await resolveWorkspacePath(grant, relativePath)
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 500).map(entry => ({
      name: entry.name, relativePath: path.join(relativePath, entry.name), directory: entry.isDirectory(),
    }))
}

export async function readWorkspaceFile(grant: WorkspaceGrant, relativePath: string): Promise<string> {
  const target = await resolveWorkspacePath(grant, relativePath)
  const info = await stat(target)
  if (!info.isFile() || info.size > 512 * 1024) throw new Error('Choose a text file smaller than 512 KiB')
  const handle = await open(target, 'r')
  try {
    const bytes = Buffer.alloc(512 * 1024 + 1)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 512 * 1024) throw new Error('File exceeds 512 KiB')
    const content = bytes.subarray(0, result.bytesRead)
    if (content.includes(0)) throw new Error('Binary files cannot be attached as text')
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } finally { await handle.close() }
}
