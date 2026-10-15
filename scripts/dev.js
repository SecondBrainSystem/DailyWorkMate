#!/usr/bin/env node

const { spawn } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const extraArgs = process.argv.slice(2).filter(arg => arg !== '--dry-run')
const dryRun = process.argv.includes('--dry-run')

let command
let args

if (process.platform === 'win32') {
  command = process.execPath
  args = [
    path.join(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    'dev',
    ...extraArgs,
  ]
} else {
  command = 'bash'
  args = [path.join(projectRoot, 'scripts', 'dev.sh'), ...extraArgs]
}

if (dryRun) {
  console.log(JSON.stringify({ platform: process.platform, command, args }))
  process.exit(0)
}

const child = spawn(command, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
})

child.on('error', error => {
  console.error(`Failed to start DailyWorkMate development server: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
