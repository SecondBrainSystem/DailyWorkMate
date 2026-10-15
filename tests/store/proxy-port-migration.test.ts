import test from 'node:test'
import assert from 'node:assert/strict'

import { migrateLegacyProxyPort } from '../../src/main/store/types.ts'

test('migrates the legacy default proxy port from 8080 to 11434 once', () => {
  assert.deepEqual(migrateLegacyProxyPort({ proxyPort: 8080 }), {
    proxyPort: 11434,
    proxyPortDefaultMigrated: true,
  })
})

test('preserves a user-selected proxy port', () => {
  assert.deepEqual(migrateLegacyProxyPort({ proxyPort: 9000 }), {
    proxyPort: 9000,
    proxyPortDefaultMigrated: true,
  })
})

test('does not change an explicitly migrated port', () => {
  assert.deepEqual(migrateLegacyProxyPort({
    proxyPort: 8080,
    proxyPortDefaultMigrated: true,
  }), {
    proxyPort: 8080,
    proxyPortDefaultMigrated: true,
  })
})
