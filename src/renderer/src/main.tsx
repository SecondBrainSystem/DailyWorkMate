import { migrateRendererData } from './lib/brandMigration'

void migrateRendererData(localStorage, indexedDB).then(() => import('./bootstrap')).catch(error => {
  console.error('[Migration] Could not restore existing settings or history:', error)
  const message = document.createElement('p')
  message.style.cssText = 'padding:32px;font:16px system-ui;white-space:pre-wrap'
  message.textContent = 'DailyWorkMate could not restore your existing data. Close the previous app and restart. Original data has been preserved.\n\n' + String(error)
  document.getElementById('root')?.replaceChildren(message)
})
