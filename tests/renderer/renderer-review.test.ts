import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FOCUS_MODE_SHORTCUT, focusModeKeyAction } from '../../src/renderer/src/hooks/useFocusMode.ts'
import { createVoiceLevel } from '../../src/renderer/src/lib/voiceLevel.ts'
import { listenerAddress, listenerUrl } from '../../src/renderer/src/components/proxy/listener-utils.ts'
import { isChineseLanguage } from '../../src/renderer/src/hooks/useIsChinese.ts'

const key = (value: string, extra: Partial<KeyboardEvent> = {}) => ({ key: value, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra })
const idle = { active: true, eligible: true, inTerminal: false, popupOpen: false }

test('Escape in focus mode belongs to the focused terminal and to open popups', () => {
  assert.equal(focusModeKeyAction(key('Escape'), idle), 'exit')
  assert.equal(focusModeKeyAction(key('Escape'), { ...idle, inTerminal: true }), null, 'Claude Code, OpenCode and vim need Escape')
  assert.equal(focusModeKeyAction(key('Escape'), { ...idle, popupOpen: true }), null, 'an open dialog, menu or select closes first')
  assert.equal(focusModeKeyAction(key('Escape', { isComposing: true }), idle), null)
  assert.equal(focusModeKeyAction(key('Escape'), { ...idle, active: false }), null)
})

test('F11 toggles focus mode everywhere, including inside a terminal', () => {
  assert.equal(FOCUS_MODE_SHORTCUT, 'F11')
  assert.equal(focusModeKeyAction(key('F11'), { ...idle, inTerminal: true }), 'toggle')
  assert.equal(focusModeKeyAction(key('F11'), { ...idle, active: false }), 'toggle')
  assert.equal(focusModeKeyAction(key('F11'), { ...idle, active: false, eligible: false }), null, 'Chat view has no focus mode')
  assert.equal(focusModeKeyAction(key('F11', { ctrlKey: true }), idle), null)
  const page = readFileSync('src/renderer/src/pages/Companion.tsx', 'utf8')
  assert.match(page, /aria-keyshortcuts=\{FOCUS_MODE_SHORTCUT\}/)
})

test('the voice meter notifies subscribers only on change and never re-renders through React state', () => {
  const level = createVoiceLevel()
  const seen: number[] = []
  const unsubscribe = level.subscribe(value => seen.push(value))
  level.set(0.4); level.set(0.4); level.set(3); level.set(Number.NaN)
  unsubscribe(); level.set(0.2)
  assert.deepEqual(seen, [0.4, 1, 0])
  assert.equal(level.get(), 0.2)
  const voice = readFileSync('src/renderer/src/components/companion/useVoice.ts', 'utf8')
  assert.doesNotMatch(voice, /useState\(0\)/)
})

test('addresses are bracketed for IPv6 everywhere they are shown or copied', () => {
  assert.equal(listenerAddress({ host: '::1', port: 11434 }), '[::1]:11434')
  assert.equal(listenerAddress({ host: '[::1]', port: 11434 }), '[::1]:11434')
  assert.equal(listenerUrl({ host: '::1', port: 11434 }), 'http://[::1]:11434/v1')
  assert.equal(listenerAddress({ host: '127.0.0.1', port: 8080 }), '127.0.0.1:8080')
})

test('one language check is shared, and conversation pages take their text from the locale files', () => {
  assert.equal(isChineseLanguage('zh-CN'), true)
  assert.equal(isChineseLanguage('ZH'), true)
  assert.equal(isChineseLanguage('en-US'), false)
  assert.equal(isChineseLanguage(undefined), false)
  for (const file of ['components/layout/Header.tsx', 'components/companion/OpenCodePanel.tsx', 'components/companion/WorkSessions.tsx']) {
    assert.match(readFileSync('src/renderer/src/' + file, 'utf8'), /useIsChinese\(\)/, file)
  }
  for (const file of ['pages/Companion.tsx', 'pages/Chat.tsx', 'components/companion/TerminalPanel.tsx', 'components/chat/ChatWorkspaceAccess.tsx']) {
    assert.doesNotMatch(readFileSync('src/renderer/src/' + file, 'utf8'), /\bchinese \?|startsWith\('zh'\)/, file)
  }
})

test('companion page recovers from a failed history load and streams without whole-page work', () => {
  const page = readFileSync('src/renderer/src/pages/Companion.tsx', 'utf8')
  // A failed start applies an empty conversation and offers Retry instead of locking the page.
  assert.match(page, /if \(!live\.current\.conversation\) applyConversation\(createConversation\(/)
  assert.match(page, /onClick=\{\(\) => \{ void initialize\(\) \}\}/)
  // No per-keystroke conversation rebuild or attachment measuring.
  assert.doesNotMatch(page, /useMemo\(\(\) => conversation \? createConversation/)
  // Following output scrolls only the list, and only while the reader is at the bottom.
  assert.doesNotMatch(page, /scrollIntoView\(\{ block: 'end', behavior: 'smooth' \}\)/)
  assert.match(page, /if \(list && followOutput\.current\) list\.scrollTop = list\.scrollHeight/)
  assert.match(page, /textFrame = requestAnimationFrame\(flushText\)/)
  assert.match(readFileSync('src/renderer/src/components/companion/CompanionMessageItem.tsx', 'utf8'), /export const CompanionMessageItem = memo\(/)
  assert.match(readFileSync('src/renderer/src/components/chat/MessageMarkdown.tsx', 'utf8'), /export const MessageMarkdown = memo\(/)
})
