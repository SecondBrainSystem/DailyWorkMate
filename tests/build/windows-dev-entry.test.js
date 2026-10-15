const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

test('default dev command uses the cross-platform Node entry', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.scripts.dev, 'node scripts/dev.js')
})

test('Windows dev entry launches electron-vite directly without Bash', { skip: process.platform !== 'win32' }, () => {
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/dev.js', '--dry-run'], {
    encoding: 'utf8',
  }))

  assert.equal(result.platform, 'win32')
  assert.equal(result.command, process.execPath)
  assert.match(result.args[0], /node_modules[\\/]electron-vite[\\/]bin[\\/]electron-vite\.js$/)
  assert.equal(result.args[1], 'dev')
  assert.equal(result.args.some(arg => /\bbash\b/i.test(arg)), false)
})
