const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

test('Windows local packaging does not require winCodeSign symlink privileges', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.build.win.signAndEditExecutable, false)
})
