import test from 'node:test'
import assert from 'node:assert/strict'
import { TRANSLATION_TARGETS, isTranslationTarget, withTranslationTarget } from '../../src/renderer/src/lib/translation.ts'
import { normalizeChatWorkspace } from '../../src/renderer/src/lib/chatWorkspace.ts'

const prompt = 'You are a professional translator. If no target is specified, translate Chinese into natural English.'

test('a chosen target language is sent with the translation prompt; auto keeps the prompt as is', () => {
  assert.equal(withTranslationTarget(prompt, 'auto'), prompt)
  const german = withTranslationTarget(prompt, 'de')
  assert.ok(german.startsWith(prompt))
  assert.match(german, /Target language: German \(Deutsch\)\. Translate the user content into German \(Deutsch\) whatever its source language/)
  assert.match(withTranslationTarget(prompt, 'zh-CN'), /Simplified Chinese \(简体中文\)/)
  assert.match(withTranslationTarget('', 'en'), /^Target language: English\./)
  for (const id of ['en', 'de', 'zh-CN', 'zh-TW', 'ja']) assert.ok(TRANSLATION_TARGETS.some(target => target.id === id))
})

test('the target language is saved with the conversation and invalid values are dropped', () => {
  assert.equal(isTranslationTarget('de'), true)
  assert.equal(isTranslationTarget('klingon'), false)
  const base = { messages: [], model: 'm', promptId: 'chat-translate', vision: 'auto', thinking: 'auto' }
  assert.equal(normalizeChatWorkspace({ ...base, translationTarget: 'de' }).translationTarget, 'de')
  assert.equal(normalizeChatWorkspace({ ...base, translationTarget: 'klingon' }).translationTarget, undefined)
  assert.equal(normalizeChatWorkspace(base).translationTarget, undefined)
})
