const { readdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const files = readdirSync(path.join(root, 'tests'), { recursive: true })
  .filter(file => /\.test\.(ts|mjs|js)$/.test(file))
  .map(file => path.join('tests', file))
  .sort()
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
