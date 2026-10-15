// Keep optional runtimes inside this project; never require a global installation.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const version = '2.0.24'
// V2 has its own package and database/protocol; keep the V1 installation intact.
const root = path.resolve(__dirname, '..', 'companion', 'runtime', 'opencode-v2')
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode/cli': version } }, null, 2) + '\n')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this installer with npm run companion:setup')
const result = spawnSync(process.execPath, [npmCli, 'install', '--prefix', root, '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
if (result.status === 0) {
  const executable = path.join(root, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  const checked = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (checked.error || checked.status !== 0 || checked.stdout.trim() !== 'opencode v' + version) throw new Error('Installed OpenCode V2 did not pass its version check')
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({ version, package: '@opencode/cli', platform: process.platform, arch: process.arch }, null, 2) + '\n')
}
process.exitCode = result.status ?? 1
