import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, migrateLegacyProxyPort } from '../../src/main/store/types.ts'

test('public API defaults to 11434 without changing saved custom ports', () => {
  assert.equal(DEFAULT_CONFIG.proxyPort, 11434)
  assert.equal(migrateLegacyProxyPort({ proxyPort: 32123 }).proxyPort, 32123)
})

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
