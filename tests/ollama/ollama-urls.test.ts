import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeOllamaUrl, parseOllamaUrlList } from '../../src/main/ollama/urls.ts'

test('normalizes Ollama roots and removes query, fragment, and trailing slash', () => {
  assert.equal(normalizeOllamaUrl(' HTTP://Example.COM:11434/path/?x=1#test '), 'http://example.com:11434/path')
})

test('parses one URL per line, ignores comments, deduplicates, and reports invalid lines', () => {
  const result = parseOllamaUrlList(`
    # trusted nodes
    http://127.0.0.1:11434/
    http://127.0.0.1:11434
    // another comment
    https://example.com/ollama/
    ftp://invalid.example.com
    not-a-url
  `)
  assert.deepEqual(result.urls, [
    'http://127.0.0.1:11434',
    'https://example.com/ollama',
  ])
  assert.deepEqual(result.invalid, ['ftp://invalid.example.com', 'not-a-url'])
})
