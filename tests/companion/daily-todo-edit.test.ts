import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, realpath, link } from 'node:fs/promises'
import path from 'node:path'
import { copyTodoToday, editTodoTask, readTodo, setTodoTask } from '../../src/main/companion/dailyTodo.ts'
import { editMarkdownTask, markdownTasks, unfinishedTodoMarkdown } from '../../src/shared/todoMarkdown.ts'

async function workspace(content: string) {
  await mkdir(path.resolve('tmp'), { recursive: true })
  const directory = await realpath(await mkdtemp(path.join(path.resolve('tmp'), 'todo-edit-')))
  const grant = { id: 'edit', name: 'Test', path: directory, writable: true }
  await writeFile(path.join(directory, 'todo-2026-10-20.md'), content)
  return grant
}
const file = 'todo-2026-10-20.md'
const today = new Date(2026, 9, 21, 12)

test('unfinished copy preserves Markdown, BOM and newlines, and promotes pending descendants of completed parents', () => {
  const original = '\uFEFF# Plan\r\n\r\n- [x] completed parent\r\n  notes to discard\r\n  - [ ] **pending child**\r\n    detail\r\n    - [x] finished grandchild\r\n    - [/] active grandchild\r\n  - [x] finished child\r\n- [/] active parent\r\n  - [x] finished nested\r\n  - [ ] pending nested\r\n\r\n> - [x] quoted done\r\n>   - [ ] quoted pending\r\n\r\n```md\r\n- [x] code example\r\n```\r\n'
  const result = unfinishedTodoMarkdown(original)
  assert.deepEqual(markdownTasks(result).map(({ text, status }) => [text, status]), [
    ['pending child\r\ndetail', 'todo'], ['active grandchild', 'doing'], ['active parent', 'doing'], ['pending nested', 'todo'], ['quoted pending', 'todo'],
  ])
  assert.ok(result.startsWith('\uFEFF# Plan\r\n'))
  assert.ok(result.includes('- [ ] **pending child**\r\n  detail\r\n  - [/] active grandchild\r\n'))
  assert.ok(result.includes('> - [ ] quoted pending'))
  assert.ok(result.includes('```md\r\n- [x] code example\r\n```'))
  assert.doesNotMatch(result, /completed parent|notes to discard|finished|quoted done/)
  assert.equal(unfinishedTodoMarkdown('- [ ] A\n- [/] B'), '- [ ] A\n- [/] B')
  assert.equal(unfinishedTodoMarkdown('- [x] A'), '')
})

test('task editing keeps status, inline Markdown, nested content and mixed newlines; deleting removes the full task block', () => {
  const content = '\uFEFF# Plan\r\n1. [/] **Old**\r\n   continued details\n   - [ ] Child\r\n2. [ ] Keep\n'
  const edited = editMarkdownTask(content, { action: 'edit', line: 1, text: '**新标题** [link](https://example.com)' })
  assert.equal(edited, content.replace('**Old**', '**新标题** [link](https://example.com)'))
  const deleted = editMarkdownTask(edited, { action: 'delete', line: 1 })
  assert.equal(deleted, '\uFEFF# Plan\r\n2. [ ] Keep\n')
  assert.equal(editMarkdownTask('\uFEFF- [x] Only\r\n', { action: 'delete', line: 0 }), '\uFEFF')
  const added = editMarkdownTask(deleted, { action: 'add', text: '  **Added**  ' })
  assert.deepEqual(markdownTasks(added).map(task => task.text), ['Keep', 'Added'])
  assert.ok(added.endsWith('- [ ] **Added**\r\n'))
  assert.equal(markdownTasks(editMarkdownTask('', { action: 'add', text: 'First' })).length, 1)
  for (const text of ['', '   ', 'two\nlines', 'a\0b', 'a'.repeat(2001)]) assert.throws(() => editMarkdownTask(content, { action: 'add', text }), /Enter a task/)
  assert.throws(() => editMarkdownTask('```\nopen', { action: 'add', text: 'Cannot hide in code' }), /Close open/)
  assert.throws(() => editMarkdownTask(content, { action: 'edit', line: 9, text: 'Missing' }), /task changed/)
  assert.throws(() => editMarkdownTask(content, { action: 'unknown' } as never), /Invalid/)
})

test('file add/edit/delete persist with revision protection, source fidelity and no staging leftovers', async () => {
  const original = '\uFEFF# Plan\r\n- [/] **Original**\r\n  - [ ] Child\n- [x] Keep\r\n'
  const grant = await workspace(original)
  let document = await readTodo(grant, file)
  document = await editTodoTask(grant, file, { revision: document.revision, edit: { action: 'edit', line: 1, text: '**Revised**' } })
  assert.equal(document.content, original.replace('**Original**', '**Revised**'))
  assert.equal((await readTodo(grant, file)).revision, document.revision)
  document = await editTodoTask(grant, file, { revision: document.revision, edit: { action: 'add', text: 'Added' } })
  assert.equal(markdownTasks(document.content).at(-1)?.text, 'Added')
  document = await editTodoTask(grant, file, { revision: document.revision, edit: { action: 'delete', line: 1 } })
  assert.deepEqual(markdownTasks(document.content).map(task => task.text), ['Keep', 'Added'])
  assert.equal(await readFile(path.join(grant.path, file), 'utf8'), document.content)
  assert.deepEqual(await readdir(grant.path), [file])
  await writeFile(path.join(grant.path, file), '- [ ] External')
  await assert.rejects(editTodoTask(grant, file, { revision: document.revision, edit: { action: 'add', text: 'Stale' } }), /changed elsewhere/)
  assert.equal(await readFile(path.join(grant.path, file), 'utf8'), '- [ ] External')
})

test('task edits enforce authorization, hard-link protection, boundaries and serialize with status changes', async () => {
  const grant = await workspace('- [ ] A\n- [ ] B')
  const document = await readTodo(grant, file)
  const request = { revision: document.revision, edit: { action: 'add', text: 'C' } } as const
  await assert.rejects(editTodoTask({ ...grant, writable: false }, file, request), /read only/)
  await assert.rejects(editTodoTask(grant, '../' + file, request), /inside/)
  await assert.rejects(editTodoTask(grant, file, { ...request, revision: '' }), /Invalid/)
  await assert.rejects(editTodoTask(grant, file, { ...request, edit: { action: 'delete', line: -1 } }), /Invalid/)
  const attempts = await Promise.allSettled([
    editTodoTask(grant, file, request),
    setTodoTask(grant, file, { revision: document.revision, line: 0, status: 'done' }),
  ])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  await link(path.join(grant.path, file), path.join(grant.path, 'linked.md'))
  const linked = await readTodo(grant, 'linked.md')
  await assert.rejects(editTodoTask(grant, 'linked.md', { ...request, revision: linked.revision }), /hard link/)
})

test('unfinished copy uses the latest series, preserves originals, avoids collisions and rejects an all-done latest note', async () => {
  const grant = await workspace('- [ ] Old')
  const latest = '\uFEFF# Latest\r\n- [x] Done\r\n- [/] In progress\r\n- [ ] Pending\r\n'
  await writeFile(path.join(grant.path, 'todo-2026-10-21.md'), latest)
  const copy = await copyTodoToday(grant, file, today, 'unfinished')
  assert.equal(copy.relativePath, 'todo-2026-10-21 (2).md')
  assert.equal(copy.copiedFrom, 'todo-2026-10-21.md')
  assert.equal(copy.document.content, latest.replace('- [x] Done\r\n', ''))
  assert.equal((await readTodo(grant, copy.relativePath)).revision, copy.document.revision)
  assert.equal(await readFile(path.join(grant.path, 'todo-2026-10-21.md'), 'utf8'), latest)
  const again = await copyTodoToday(grant, file, today, 'unfinished')
  assert.equal(again.relativePath, 'todo-2026-10-21 (3).md')
  const done = await workspace('# Plan\n- [x] All done')
  await assert.rejects(copyTodoToday(done, file, today, 'unfinished'), /no unfinished/)
  await assert.rejects(copyTodoToday(done, file, today, 'invalid' as never), /Invalid/)
  assert.deepEqual(await readdir(done.path), [file])
})
