const path = require('node:path')
const packageCompanion = require('./package-companion.cjs')

module.exports = async context => {
  await packageCompanion(context)
  if (context.electronPlatformName !== 'win32') return
  // Use Electron's standalone resource editor. electron-builder's combined signing
  // tools archive contains macOS symlinks that require extra Windows privileges.
  const { rcedit } = await import('rcedit')
  const info = context.packager.appInfo
  await rcedit(path.join(context.appOutDir, info.productFilename + '.exe'), {
    icon: path.resolve(__dirname, '../build/icon.ico'),
    'file-version': info.version,
    'product-version': info.version,
    'version-string': {
      ProductName: info.productName, FileDescription: info.description,
      CompanyName: 'DailyWorkMate contributors', LegalCopyright: info.copyright,
      InternalName: info.productFilename, OriginalFilename: info.productFilename + '.exe',
    },
    'requested-execution-level': 'asInvoker',
  })
}
