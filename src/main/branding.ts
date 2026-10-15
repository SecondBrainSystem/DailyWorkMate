import { app, dialog } from 'electron'
import { homedir } from 'node:os'
import { legacyEnvironment, migrateApplicationData } from './brandMigration'

// This module runs before services construct their stores or read environment overrides.
process.env = legacyEnvironment(process.env)
if (app.isPackaged) {
  try {
    migrateApplicationData(homedir(), app.getPath('appData'), app.getPath('userData'))
  } catch (error) {
    console.error('[Migration] Unable to preserve existing application data:', error)
    dialog.showErrorBox('DailyWorkMate', 'Could not migrate your existing data. Close the previous application and retry. Your original files have been preserved.\n\n' + String(error))
    app.exit(1)
  }
}
if (process.platform === 'win32') app.setAppUserModelId('com.dailyworkmate.desktop')
