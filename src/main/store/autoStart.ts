import { app } from 'electron'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function applyAutoStart(enabled: boolean): void {
  if (process.platform !== 'linux') { app.setLoginItemSettings({ openAtLogin: enabled }); return }
  const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart')
  // Retire the old desktop entry so upgrades do not launch two applications at login.
  rmSync(join(directory, 'chat2api.desktop'), { force: true })
  const file = join(directory, 'dailyworkmate.desktop')
  if (!enabled) { rmSync(file, { force: true }); return }
  const quote = (value: string) => '"' + value.replace(/["\\`$]/g, '\\$&').replace(/[\r\n]/g, '') + '"'
  const command = quote(process.execPath) + (app.isPackaged ? '' : ' ' + quote(app.getAppPath()))
  mkdirSync(directory, { recursive: true })
  writeFileSync(file, '[Desktop Entry]\nType=Application\nName=DailyWorkMate\nExec=' + command + '\nTerminal=false\nX-GNOME-Autostart-enabled=true\n', { mode: 0o600 })
}
