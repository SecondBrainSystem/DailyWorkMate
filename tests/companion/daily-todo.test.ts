import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, link } from 'node:fs/promises'
import path from 'node:path'
import { copyTodoToday, readTodo, setTodoTask } from '../../src/main/companion/dailyTodo.ts'
import { datedTodoName, markdownTasks, setMarkdownTask, todoMarkdownSource } from '../../src/shared/todoMarkdown.ts'

async function workspace() {
  const directory = await realpath(await mkdtemp(path.join(path.resolve('tmp'), 'todo-files-')))
  await mkdir(path.join(directory, 'Daily'))
  return { id: 'test', name: 'Test', path: directory, writable: true }
}
const today = new Date(2026, 9, 20, 12)

test('GFM tasks map to original bytes through BOM, YAML, nested lists and quotes; code and HTML are not tasks', () => {
  const content = '\uFEFF---\r\ntitle: todo\r\n- [ ] metadata\r\n---\r\n# 计划\r\n- [ ] **写摘要**\r\n  - [X] 嵌套\r\n> - [ ] 引用\r\n\r\n1. [ ] 有序\r\n\r\n```md\r\n- [ ] example\r\n```\r\n\r\n    - [ ] indented code\r\n\r\n<div>\r\n- [ ] html\r\n</div>'
  const tasks = markdownTasks(content)
  assert.deepEqual(tasks.map(task => [task.line, task.done]), [[5, false], [6, true], [7, false], [9, false]])
  assert.equal(tasks[0].text, '写摘要')
  assert.equal(setMarkdownTask(content, 7, true), content.replace('> - [ ]', '> - [x]'))
  assert.equal(setMarkdownTask(content, 6, false), content.replace('[X]', '[ ]'))
  assert.throws(() => setMarkdownTask(content, 12, true), /task changed/)
  assert.equal(todoMarkdownSource(content).length, content.length, 'metadata masking preserves offsets')
})

test('checking a disk task changes only its ASCII marker and preserves mixed newlines and BOM', async () => {
  const grant = await workspace(), file = path.join(grant.path, 'Daily/todo.md')
  const content = '\uFEFF# 中文\r\n- [ ] **甲**\n  - [X] 乙\r\n\r\n```\r\n- [ ] sample\n```\r\n'
  await writeFile(file, content)
  const snapshot = await readTodo(grant, 'Daily/todo.md')
  assert.equal(snapshot.content, content)
  const saved = await setTodoTask(grant, 'Daily/todo.md', { revision: snapshot.revision, line: 1, checked: true })
  assert.equal(await readFile(file, 'utf8'), content.replace('- [ ] **甲**', '- [x] **甲**'))
  assert.notEqual(saved.revision, snapshot.revision)
  assert.equal((await setTodoTask(grant, 'Daily/todo.md', { revision: saved.revision, line: 1, checked: true })).revision, saved.revision, 'checking is idempotent')
  await assert.rejects(setTodoTask(grant, 'Daily/todo.md', { revision: saved.revision, line: 5, checked: true }), /task changed/)
})

test('doing tasks render through GFM without changing code, HTML, metadata or source positions', () => {
  const content = '\uFEFF---\r\nstatus: [/]\r\n---\r\n- [ ] 待办\r\n  - [/] **进行中**\r\n> 1. [/] 引用任务\r\n\r\n- [x] 完成\r\n\r\n```md\r\n- [/] 代码示例\r\n```\r\n\r\n<div>\r\n- [/] HTML 示例\r\n</div>\r\n\r\n    - [/] 缩进代码'
  const tasks = markdownTasks(content)
  assert.deepEqual(tasks.map(({ line, status, text }) => [line, status, text]), [
    [3, 'todo', '待办'], [4, 'doing', '进行中'], [5, 'doing', '引用任务'], [7, 'done', '完成'],
  ])
  assert.ok(tasks.every(task => content[task.offset] === (task.status === 'doing' ? '/' : task.done ? 'x' : ' ')))
  const rendered = todoMarkdownSource(content)
  assert.equal(rendered.length, content.length)
  assert.match(rendered, /- \[ \] \*\*进行中\*\*/)
  for (const example of ['代码示例', 'HTML 示例', '缩进代码']) assert.ok(rendered.includes('- [/] ' + example))
  assert.equal(setMarkdownTask(content, 4, 'todo'), content.replace('- [/] **进行中**', '- [ ] **进行中**'))
  assert.equal(setMarkdownTask(content, 4, 'done'), content.replace('- [/] **进行中**', '- [x] **进行中**'))
  assert.throws(() => setMarkdownTask(content, 10, 'doing'), /task changed/)
})

test('all three states save to disk losslessly and invalid status requests cannot write', async () => {
  const grant = await workspace(), file = path.join(grant.path, 'Daily/todo.md')
  const original = '\uFEFF# 今天\r\n- [ ] **任务**\n  - [x] 子任务\r\n'
  await writeFile(file, original)
  let document = await readTodo(grant, 'Daily/todo.md')
  for (const [status, marker] of [['doing', '/'], ['done', 'x'], ['todo', ' ']] as const) {
    document = await setTodoTask(grant, 'Daily/todo.md', { revision: document.revision, line: 1, status })
    assert.equal(await readFile(file, 'utf8'), original.replace('- [ ] **任务**', `- [${marker}] **任务**`))
    assert.equal((await setTodoTask(grant, 'Daily/todo.md', { revision: document.revision, line: 1, status })).revision, document.revision)
  }
  for (const value of [{ status: 'invalid' }, { status: null }, {}, { status: 'doing', checked: true }]) {
    await assert.rejects(setTodoTask(grant, 'Daily/todo.md', { revision: document.revision, line: 1, ...value } as never), /Invalid todo/)
  }
  await assert.rejects(setTodoTask({ ...grant, writable: false }, 'Daily/todo.md', { revision: document.revision, line: 1, status: 'doing' }), /read only/)
  assert.equal(await readFile(file, 'utf8'), original)
})

test('an external edit or simultaneous stale checkbox cannot overwrite a newer file version', async () => {
  const grant = await workspace(), file = path.join(grant.path, 'Daily/todo.md')
  await writeFile(file, '- [ ] A\n- [ ] B')
  const snapshot = await readTodo(grant, 'Daily/todo.md')
  const attempts = await Promise.allSettled([0, 1].map(line => setTodoTask(grant, 'Daily/todo.md', { revision: snapshot.revision, line, checked: true })))
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const external = '# Edited elsewhere\n- [ ] C'
  await writeFile(file, external)
  await assert.rejects(setTodoTask(grant, 'Daily/todo.md', { revision: snapshot.revision, line: 0, checked: true }), /changed elsewhere/)
  assert.equal(await readFile(file, 'utf8'), external)
})

test('read-only grants, invalid inputs, binary data, oversized files and escaped paths cannot be written', async () => {
  const grant = await workspace(), file = path.join(grant.path, 'Daily/todo.md')
  await writeFile(file, '- [ ] A')
  const snapshot = await readTodo(grant, 'Daily/todo.md'), change = { revision: snapshot.revision, line: 0, checked: true }
  await assert.rejects(setTodoTask({ ...grant, writable: false }, 'Daily/todo.md', change), /read only/)
  await assert.rejects(copyTodoToday({ ...grant, writable: false }, 'Daily/todo.md', today), /read only/)
  await assert.rejects(setTodoTask(grant, 'Daily/todo.md', { ...change, line: -1 }), /Invalid/)
  await assert.rejects(setTodoTask(grant, 'Daily/todo.md', { ...change, revision: '' }), /Invalid/)
  await assert.rejects(readTodo(grant, '../todo.md'), /inside/)
  await assert.rejects(copyTodoToday(grant, file, today), /inside/)
  await writeFile(path.join(grant.path, 'Daily/binary.md'), Buffer.from([1, 0, 2]))
  await assert.rejects(readTodo(grant, 'Daily/binary.md'), /UTF-8/)
  await writeFile(path.join(grant.path, 'Daily/large.md'), Buffer.alloc(512 * 1024 + 1, 65))
  await assert.rejects(readTodo(grant, 'Daily/large.md'), /512/)
  await writeFile(path.join(grant.path, 'Daily/bad.md'), Buffer.from([0xc0, 0xff]))
  await assert.rejects(readTodo(grant, 'Daily/bad.md'), /encoded data/)
  const outside = await workspace()
  await writeFile(path.join(outside.path, 'todo.md'), '- [ ] outside')
  await symlink(outside.path, path.join(grant.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(setTodoTask(grant, 'escape/todo.md', change), /outside/)
  await assert.rejects(copyTodoToday(grant, 'escape/todo.md', today), /outside/)
  await link(path.join(outside.path, 'todo.md'), path.join(grant.path, 'Daily/linked.md'))
  const linked = await readTodo(grant, 'Daily/linked.md')
  await assert.rejects(setTodoTask(grant, 'Daily/linked.md', { ...change, revision: linked.revision }), /hard link/)
  assert.equal(await readFile(file, 'utf8'), '- [ ] A')
})

test('today copy uses the latest same-series version even when an older note is selected, preserving content and originals', async () => {
  const grant = await workspace()
  const files = {
    'todo-2026-10-18.md': '- [ ] old',
    'todo-2026-10-19.md': '\uFEFF# Plan\r\n- [x] Done\r\n- [ ] Latest\r\n',
    'todo-2026-10-22.md': '- [ ] future',
    'other-2026-10-20.md': '- [ ] unrelated',
  }
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(grant.path, 'Daily', name), content)
  const copy = await copyTodoToday(grant, 'Daily/todo-2026-10-18.md', today)
  assert.equal(copy.relativePath, path.join('Daily', 'todo-2026-10-20.md'))
  assert.equal(copy.copiedFrom, path.join('Daily', 'todo-2026-10-19.md'))
  assert.equal(copy.document.content, files['todo-2026-10-19.md'])
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(grant.path, 'Daily', name), 'utf8'), content)
  const duplicates = await Promise.all([1, 2].map(() => copyTodoToday(grant, 'Daily/todo-2026-10-18.md', today)))
  assert.equal(new Set(duplicates.map(result => result.relativePath)).size, 2)
  assert.ok(duplicates.every(result => /2026-10-20 \([23]\)\.md$/.test(result.relativePath)))
  assert.ok(duplicates.every(result => result.document.content === files['todo-2026-10-19.md']))
})

test('date names handle undated notes, compact dates and previous copy suffixes', async () => {
  assert.equal(datedTodoName('DailyTodo.md', '2026-10-20'), 'DailyTodo-2026-10-20.md')
  assert.equal(datedTodoName('20261019 (2).md', '2026-10-20', 3), '2026-10-20 (3).md')
  const grant = await workspace()
  await writeFile(path.join(grant.path, 'Daily/todo.md'), '- [ ] undated')
  assert.equal((await copyTodoToday(grant, 'Daily/todo.md', today)).relativePath, path.join('Daily', 'todo-2026-10-20.md'))
})
