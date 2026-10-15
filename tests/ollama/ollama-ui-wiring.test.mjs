import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('Ollama management page is connected through navigation, IPC, and preload', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const sidebar = readFileSync('src/renderer/src/components/layout/navigation.ts', 'utf8')
  const channels = readFileSync('src/main/ipc/channels.ts', 'utf8')
  const handlers = readFileSync('src/main/ipc/handlers.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const page = readFileSync('src/renderer/src/pages/OllamaNodes.tsx', 'utf8')
  const monitor = readFileSync('src/renderer/src/components/ollama/OllamaLogMonitor.tsx', 'utf8')

  assert.match(app, /path="\/ollama"/)
  assert.match(sidebar, /href: '\/ollama'/)
  assert.match(channels, /OLLAMA_IMPORT_TEXT/)
  assert.match(channels, /OLLAMA_SET_MODEL_ENABLED/)
  assert.match(handlers, /OllamaNodeManager\.importText/)
  assert.match(handlers, /OllamaNodeManager\.setModelEnabled/)
  assert.match(preload, /ollama: ollamaAPI/)
  assert.match(page, /OllamaLogMonitor/)
  assert.match(page, /handleManualAdd/)
  assert.match(page, /ollamaRouting/)
  assert.match(page, /autoSelectUrl/)
  assert.match(monitor, /providerId: selectedNode/)
  assert.match(monitor, /window\.electronAPI\.logs\.get/)
})
