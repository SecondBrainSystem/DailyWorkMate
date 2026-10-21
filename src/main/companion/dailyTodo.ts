import { createHash, randomUUID } from 'node:crypto'
import { open, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { TodoCopy, TodoCopyMode, TodoDocument, TodoTaskChange, TodoTaskEditRequest, WorkspaceGrant } from '../../shared/companion'
import { datedTodoName, editMarkdownTask, isTodoTaskStatus, localTodoDay, markdownTasks, todoDate, todoFilePattern, todoSeries, todoTaskMarker, unfinishedTodoMarkdown } from '../../shared/todoMarkdown.ts'
import { resolveWorkspacePath } from './workspaces.ts'

const limit = 512 * 1024
const conflict = () => new Error('文件已被其他操作修改，请刷新后重新编辑。 / File changed elsewhere; refresh before editing this task again.')
const documentOf = (bytes: Buffer): TodoDocument => {
  if (bytes.includes(0)) throw new Error('请选择 UTF-8 Markdown 文本。 / Choose a UTF-8 Markdown text file.')
  return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), revision: createHash('sha256').update(bytes).digest('hex') }
}
function writable(grant: WorkspaceGrant) {
  if (!grant.writable) throw new Error('此工作区为只读，请在文件夹权限中启用编辑。 / This workspace is read only; enable editing in folder permissions.')
}
async function targetPath(grant: WorkspaceGrant, relativePath: string) {
  const target = await resolveWorkspacePath(grant, relativePath)
  if (!todoFilePattern.test(target)) throw new Error('请选择 .md、.markdown 或 .txt 待办文件。 / Choose an .md, .markdown or .txt todo file.')
  return target
}
async function readBytes(handle: FileHandle): Promise<Buffer> {
  const info = await handle.stat()
  if (!info.isFile() || info.size > limit) throw new Error('请选择小于 512 KiB 的待办文件。 / Choose a todo file smaller than 512 KiB.')
  const bytes = Buffer.alloc(limit + 1)
  let count = 0
  while (count < bytes.length) {
    const result = await handle.read(bytes, count, bytes.length - count, count)
    if (!result.bytesRead) break
    count += result.bytesRead
  }
  if (count > limit) throw new Error('待办文件超过 512 KiB。 / Todo file exceeds 512 KiB.')
  return bytes.subarray(0, count)
}
async function readBytesAt(grant: WorkspaceGrant, relativePath: string): Promise<Buffer> {
  const handle = await open(await targetPath(grant, relativePath), 'r')
  try { return await readBytes(handle) } finally { await handle.close() }
}
export async function readTodo(grant: WorkspaceGrant, relativePath: string): Promise<TodoDocument> {
  return documentOf(await readBytesAt(grant, relativePath))
}

// Serialize our own writes; the revision also detects edits by an editor or another app window.
let writes = new Map<string, Promise<unknown>>()
async function serialize<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  const previous = writes.get(key)
  const pending = (async () => { if (previous) await previous.catch(() => undefined); return operation() })()
  writes = new Map([...writes, [key, pending]])
  try { return await pending } finally {
    if (writes.get(key) === pending) writes = new Map([...writes].filter(([item]) => item !== key))
  }
}
export async function setTodoTask(grant: WorkspaceGrant, relativePath: string, change: TodoTaskChange): Promise<TodoDocument> {
  writable(grant)
  if (!change || typeof change !== 'object' || typeof change.revision !== 'string' || !/^[a-f0-9]{64}$/.test(change.revision)
    || !Number.isSafeInteger(change.line) || change.line < 0
    || !(isTodoTaskStatus(change.status) && change.checked === undefined
      || change.status === undefined && typeof change.checked === 'boolean')) throw new Error('Invalid todo task change')
  const status = change.status ?? (change.checked ? 'done' : 'todo')
  const target = await targetPath(grant, relativePath)
  return serialize(target, async () => {
    const handle = await open(await targetPath(grant, relativePath), 'r+')
    try {
      const bytes = await readBytes(handle), document = documentOf(bytes)
      if (document.revision !== change.revision) throw conflict()
      const task = markdownTasks(document.content).find(item => item.line === change.line)
      if (!task) throw new Error('待办项已变化，请刷新后重试。 / This task changed; refresh and try again.')
      const [opened, current] = await Promise.all([handle.stat(), stat(await targetPath(grant, relativePath))])
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw conflict()
      if (opened.nlink !== 1) throw new Error('无法修改硬链接待办，请使用独立文件。 / Use a standalone todo file instead of a hard link.')
      // Recheck immediately before changing a single ASCII byte. Preserve BOM, mixed newlines and all other text.
      if (documentOf(await readBytes(handle)).revision !== change.revision) throw conflict()
      if (task.status !== status) {
        const position = Buffer.byteLength(document.content.slice(0, task.offset), 'utf8')
        const result = await handle.write(Buffer.from(todoTaskMarker(status)), 0, 1, position)
        if (result.bytesWritten !== 1) throw new Error('未能保存待办勾选，请重试。 / Unable to save the task; try again.')
        await handle.sync()
      }
      return documentOf(await readBytes(handle))
    } finally { await handle.close() }
  })
}

/** Stage full-text edits before replacing the file; revision checks reject stale drafts. */
export async function editTodoTask(grant: WorkspaceGrant, relativePath: string, change: TodoTaskEditRequest): Promise<TodoDocument> {
  writable(grant)
  if (!change || typeof change !== 'object' || typeof change.revision !== 'string' || !/^[a-f0-9]{64}$/.test(change.revision)) throw new Error('Invalid todo task edit')
  const target = await targetPath(grant, relativePath)
  return serialize(target, async () => {
    const handle = await open(await targetPath(grant, relativePath), 'r+')
    const temporary = path.join(path.dirname(target), '.todo-' + randomUUID() + '.tmp')
    let staged = false, closed = false
    try {
      const document = documentOf(await readBytes(handle)), opened = await handle.stat()
      if (document.revision !== change.revision) throw conflict()
      if (opened.nlink !== 1) throw new Error('无法修改硬链接待办，请使用独立文件。 / Use a standalone todo file instead of a hard link.')
      const bytes = Buffer.from(editMarkdownTask(document.content, change.edit), 'utf8')
      if (bytes.length > limit) throw new Error('待办文件超过 512 KiB。 / Todo file exceeds 512 KiB.')
      const next = documentOf(bytes)
      const output = await open(temporary, 'wx', opened.mode & 0o777)
      staged = true
      try { await output.writeFile(bytes); await output.sync() } finally { await output.close() }
      const currentTarget = await targetPath(grant, relativePath), current = await stat(currentTarget)
      if (currentTarget !== target || opened.dev !== current.dev || opened.ino !== current.ino
        || documentOf(await readBytes(handle)).revision !== change.revision) throw conflict()
      // Windows may deny replacing a file while our read handle is still open.
      await handle.close(); closed = true
      await rename(temporary, target)
      staged = false
      return next
    } finally {
      if (!closed) await handle.close()
      if (staged) await unlink(temporary).catch(error => console.error('[DailyTodo] Remove staged edit:', error))
    }
  })
}

/** Copy the latest sibling version, never replacing an existing file. */
export async function copyTodoToday(grant: WorkspaceGrant, relativePath: string, now = new Date(), mode: TodoCopyMode = 'all'): Promise<TodoCopy> {
  writable(grant)
  if (mode !== 'all' && mode !== 'unfinished') throw new Error('Invalid todo copy mode')
  const selected = await targetPath(grant, relativePath)
  const directory = path.dirname(selected), series = todoSeries(path.basename(selected)), today = localTodoDay(now)
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && todoFilePattern.test(entry.name) && todoSeries(entry.name) === series)
  if (entries.length > 500) throw new Error('同系列待办超过 500 份，请先归档旧文件。 / Archive older notes before copying more than 500 versions.')
  const versions = await Promise.all(entries.map(async entry => ({ name: entry.name, date: todoDate(entry.name), modified: (await stat(path.join(directory, entry.name))).mtimeMs })))
  const score = (date: string) => date === today ? 3 : date && date < today ? 2 : date ? 0 : 1
  const latest = [...versions].sort((a, b) => score(b.date) - score(a.date) || b.date.localeCompare(a.date)
    || b.modified - a.modified || b.name.localeCompare(a.name, undefined, { numeric: true }))[0]
  if (!latest) throw new Error('未找到可复制的待办，请刷新。 / No todo file found; refresh and try again.')
  const folder = path.relative(grant.path, directory), copiedFrom = path.join(folder, latest.name)
  const sourceBytes = await readBytesAt(grant, copiedFrom), source = documentOf(sourceBytes)
  if (mode === 'unfinished' && !markdownTasks(source.content).some(task => !task.done)) {
    throw new Error('最新便签没有未完成的待办，无需创建副本。 / The latest note has no unfinished tasks to copy.')
  }
  const bytes = mode === 'unfinished' ? Buffer.from(unfinishedTodoMarkdown(source.content), 'utf8') : sourceBytes
  const document = mode === 'unfinished' ? documentOf(bytes) : source
  for (let number = 1; number <= 1000; number++) {
    const name = datedTodoName(latest.name, today, number)
    const destination = path.join(await resolveWorkspacePath(grant, folder), name)
    let handle: FileHandle
    try { handle = await open(destination, 'wx') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
    try {
      await handle.writeFile(bytes); await handle.sync()
    } catch (error) {
      // Clean up only the partial file created by this operation, never an existing user's file.
      const owned = await handle.stat()
      await handle.close()
      try {
        const current = await stat(destination)
        if (current.dev === owned.dev && current.ino === owned.ino) await unlink(destination)
      } catch (cleanupError) { console.error('[DailyTodo] Remove incomplete copy:', cleanupError) }
      throw error
    } finally { await handle.close() }
    return { relativePath: path.join(folder, name), copiedFrom, document }
  }
  throw new Error('今日待办副本过多，请先整理文件。 / Too many copies for today; organize these files first.')
}
