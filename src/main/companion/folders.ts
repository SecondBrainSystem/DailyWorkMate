import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { boundedText } from '../../shared/companion.ts'

/** Paths from drag/drop and the OS shell are untrusted until checked in the main process. */
export async function localDirectory(value: unknown): Promise<string> {
  const selected = boundedText(value, 'folder path', 4096, true)
  if (!path.isAbsolute(selected) || /[\x00-\x1f]/.test(selected)) throw new Error('请选择本地文件夹。 / Choose a local folder.')
  const directory = await realpath(selected)
  if (!(await stat(directory)).isDirectory()) throw new Error('请拖入文件夹，而不是文件。 / Drop folders, not files.')
  return directory
}

export async function openLocalDirectory(value: unknown, openPath: (directory: string) => Promise<string>): Promise<void> {
  const error = await openPath(await localDirectory(value))
  if (error) throw new Error('无法打开文件夹。 / Cannot open folder: ' + error)
}
