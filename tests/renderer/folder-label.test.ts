import test from 'node:test'
import assert from 'node:assert/strict'
import { folderLabel } from '../../src/renderer/src/lib/folderLabel.ts'

test('tab names use the last folder of a path', () => {
  assert.equal(folderLabel('C:\\Users\\me\\Desktop\\DailyToDo'), 'DailyToDo')
  assert.equal(folderLabel('C:/work/api/'), 'api')
  assert.equal(folderLabel('/home/me/project'), 'project')
  assert.equal(folderLabel('docs/notes'), 'notes')
})

test('drive and filesystem roots stay recognisable', () => {
  assert.equal(folderLabel('C:\\'), 'C:')
  assert.equal(folderLabel('/'), '/')
  assert.equal(folderLabel('  '), '')
})
