// A folder distribution starts directly; no self-extraction or temporary application copy.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'dist', 'DailyWorkMate-folder')
const builder = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [builder, '--win', '--x64', '--dir', '--publish', 'never', '-c.directories.output=' + output], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
const folder = path.join(output, 'win-unpacked')
fs.writeFileSync(path.join(folder, 'dailyworkmate-portable'), 'DailyWorkMate folder distribution\n')
fs.writeFileSync(path.join(folder, 'Start DailyWorkMate.cmd'), '@echo off\r\nstart "" "%~dp0DailyWorkMate.exe"\r\n')
fs.writeFileSync(path.join(folder, 'README.txt'), 'DailyWorkMate\r\n\r\nRun DailyWorkMate.exe. Keep this whole folder together.\r\nCompanion data is stored in companion/ beside the executable.\r\nDAILYWORKMATE_COMPANION_HOME can select an existing data folder.\r\n')
console.log('Folder distribution: ' + folder)
