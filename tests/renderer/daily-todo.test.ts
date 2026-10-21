import test from 'node:test'
import assert from 'node:assert/strict'
import { dailyChatDraft, dailyLines, discoverDailyTodos, mentionsDailyTodo, parseDailyMemo, rankDailySources, toggleDailyTask } from '../../src/renderer/src/lib/dailyTodo.ts'

test('daily keywords match names and prose without triggering on the product name or unrelated words', () => {
  for (const text of ['DailyTodo', 'daily', 'TODO', 'daily-todo', 'Daily_Todo', 'DailyNotes', 'TodoList', 'DailyTodoList', '帮我看看Daily', '今日待办', 'todo.md']) assert.equal(mentionsDailyTodo(text), true, text)
  for (const text of ['DailyWorkMate', 'methodology', 'today', 'todosomething']) assert.equal(mentionsDailyTodo(text), false, text)
})

test('discovery reads only bounded authorized folders, skips build/hidden folders, and finds nested daily notes', async () => {
  const calls: string[] = []
  const grant = { id: 'project', name: 'Project', path: 'C:/Project', writable: false }
  const result = await discoverDailyTodos({ listFiles: async (id, folder) => {
    assert.equal(id, 'project'); calls.push(folder)
    return !folder ? [
      { name: 'docs', relativePath: 'docs', directory: true },
      { name: 'node_modules', relativePath: 'node_modules', directory: true },
      { name: '.daily', relativePath: '.daily', directory: true },
      { name: 'todo.md', relativePath: '../todo.md', directory: false },
    ] : folder === 'docs' ? [{ name: 'Daily', relativePath: 'docs/Daily', directory: true }]
      : [{ name: '2026-10-20.md', relativePath: 'docs/Daily/2026-10-20.md', directory: false }]
  } }, [grant])
  assert.deepEqual(calls, ['', 'docs', 'docs/Daily'])
  assert.equal(result.matched, true)
  assert.deepEqual(result.sources.map(source => source.relativePath), ['docs/Daily/2026-10-20.md'])
})

test('empty Daily workspace still triggers a note and read failures remain visible', async () => {
  const grant = { id: 'daily', name: 'Daily', path: 'C:/Daily', writable: false }
  const empty = await discoverDailyTodos({ listFiles: async () => [] }, [grant])
  assert.equal(empty.matched, true)
  const denied = await discoverDailyTodos({ listFiles: async () => { throw new Error('revoked') } }, [grant])
  assert.match(denied.errors[0], /revoked/)
})

test('discovery stops on cancellation and on a wide directory tree', async () => {
  const grant = { id: 'project', name: 'Project', path: 'C:/Project', writable: false }
  let calls = 0
  const api = { listFiles: async (_id: string, folder: string) => { calls++; return Array.from({ length: 100 }, (_, i) => ({ name: 'dir' + i, relativePath: folder + '/dir' + i, directory: true })) } }
  const cancelled = await discoverDailyTodos(api, [grant], () => true)
  assert.equal(cancelled.sources.length, 0); assert.equal(calls, 0)
  const broad = await discoverDailyTodos({ listFiles: async (_id, folder) => {
    calls++
    return Array.from({ length: 100 }, (_, i) => ({ name: 'dir' + i, relativePath: [folder, 'dir' + i].filter(Boolean).join('/'), directory: true }))
  } }, [grant])
  assert.equal(calls, 80); assert.equal(broad.limited, true)
})

test('today and the selected workspace win over old and future notes', () => {
  const sources = ['2026-10-19.md', '2026-10-21.md', 'todo.md', '2026-10-20.md'].map(relativePath => ({ id: relativePath, relativePath, workspaceId: 'one', workspaceName: 'Daily' }))
  assert.deepEqual(rankDailySources(sources, 'one', '2026-10-20').map(source => source.id), ['2026-10-20.md', '2026-10-19.md', 'todo.md', '2026-10-21.md'])
  assert.equal(rankDailySources([...sources, { ...sources[0], workspaceId: 'two', id: 'selected' }], 'two', '2026-10-20')[0].id, 'selected')
})

test('checklists keep source text and CRLF intact and ignore code/YAML', () => {
  const content = '---\r\ntitle: daily\r\n---\r\n# Today\r\n- [ ] 写文档\r\n+ [X] Done\r\n```md\r\n- [ ] example\r\n```'
  const tasks = dailyLines(content).filter(line => line.kind === 'task')
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks.map(task => task.line), [4, 5])
  assert.equal(toggleDailyTask(content, 4), content.replace('- [ ] 写文档', '- [x] 写文档'))
  assert.equal(toggleDailyTask(content, 5), content.replace('+ [X] Done', '+ [ ] Done'))
})

test('conversation drafts need a related list; manually saved empty notes remain intentional', () => {
  assert.equal(dailyChatDraft([{ role: 'user', content: 'plan my Daily Todo' }, { role: 'assistant', content: '1. Write report\n2. Review tests' }]), '- [ ] Write report\n- [ ] Review tests')
  assert.equal(dailyChatDraft([{ role: 'user', content: 'explain this code' }, { role: 'assistant', content: '- refactor\n- test' }]), '')
  assert.equal(parseDailyMemo('{"enabled":true,"text":"","edited":true}').edited, true)
  assert.throws(() => parseDailyMemo('{"enabled":true,"text":123}'))
})

test('chat drafts preserve doing markers and a checkbox can complete an in-progress task', () => {
  const content = '- [ ] Plan\n- [/] **Write**\n- [x] Review'
  assert.equal(dailyChatDraft([{ role: 'user', content: 'Daily Todo' }, { role: 'assistant', content }]), content)
  assert.equal(toggleDailyTask(content, 1), content.replace('[/]', '[x]'))
})
