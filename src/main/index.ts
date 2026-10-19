import './branding'
import { app, BrowserWindow, nativeTheme, dialog } from 'electron'
import { join } from 'path'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools, confirmDiscardUnsavedChanges } from './window/manager'
import { createTrayManager, TrayManager } from './tray/TrayManager'
import { registerIpcHandlers } from './ipc/handlers'
import { UpdaterManager } from './updater'
import { storeManager } from './store/store'
import { shutdownCompanion, companionPsmuxDirectories } from './companion/ipc'
import { defaultPsmuxDirectories, discoverPsmux, closePsmux } from './terminal/psmux'
import { createQuitController } from './quit'
import { readStartupOptions } from './startupOptions'
import { internalInferenceBridge } from './inference/bridge'
import { sessionManager } from './proxy/sessionManager'

// An uncaught exception leaves the main process in an unknown state: report it, then quit or
// restart through the normal confirmation and cleanup. A second failure, or one while quitting, exits.
let fatalError = false
let quitRequested = false
let relaunchOnQuit = false
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  if (fatalError || quitRequested || app.isQuitting || !app.isReady()) { app.exit(1); return }
  fatalError = true
  try {
    // The settings store may be what failed, so the system locale picks the language.
    const chinese = app.getLocale().startsWith('zh')
    const choice = dialog.showMessageBoxSync({ type: 'error', title: 'DailyWorkMate', noLink: true, defaultId: 0, cancelId: 1,
      message: chinese ? 'DailyWorkMate 遇到意外错误，需要重新启动。' : 'DailyWorkMate hit an unexpected error and needs to restart.',
      detail: String(error?.stack || error).slice(0, 4000), buttons: chinese ? ['重新启动', '退出'] : ['Restart', 'Quit'] })
    relaunchOnQuit = choice === 0
    app.quit()
  } catch (reportError) {
    console.error('Unable to report the uncaught exception:', reportError)
    app.exit(1)
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

// Workaround for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug)
// Completely disable JIT compilation to prevent EXC_BAD_ACCESS crashes
// This trades some performance for stability
if (process.platform === 'darwin' && process.arch === 'arm64') {
  app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

// Software compositing saves ~120–150 MB of GPU-process memory; Settings can turn GPU compositing back on.
if (!readStartupOptions().gpuCompositing) app.commandLine.appendSwitch('disable-gpu-compositing')

// Automatically add --no-sandbox flag when running as root user
if (process.getuid && process.getuid() === 0) {
  console.log('Detected running as root user, sandbox settings have been automatically handled')
}

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', async () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    } else {
      await setupApp()
    }
  })

  initializeApp()
}

let trayManager: TrayManager | null = null

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    await setupApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      await setupApp()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', createQuitController({
    // Nothing is stopped and app.isQuitting stays false until the user has answered every question.
    confirm: async () => {
      quitRequested = true
      if (!await confirmDiscardUnsavedChanges()) return false
      const sessions = await discoverPsmux([...defaultPsmuxDirectories(), ...await companionPsmuxDirectories()])
      if (!sessions.length) return true
      const chinese = storeManager.getConfig().language === 'zh-CN'
      const result = await dialog.showMessageBox({ type: 'question', title: 'DailyWorkMate',
        message: chinese ? '退出时是否关闭 psmux 会话？' : 'Close psmux sessions when quitting?',
        detail: (chinese ? '检测到以下会话，可能包含其他终端启动的会话。关闭会同时清理其预热进程；保留后可用 psmux 重新连接。普通终端和工作任务仍会停止。\n\n' : 'These sessions may include sessions started in other terminals. Closing also stops their standby processes. Retained sessions can be reattached with psmux. Ordinary terminals and work tasks will stop.\n\n') + sessions.map(session => session.name + ' — ' + session.directory).join('\n'),
        buttons: chinese ? ['关闭这些会话并退出', '保留 psmux 并退出', '取消退出'] : ['Close these sessions and quit', 'Keep psmux and quit', 'Cancel'], defaultId: 1, cancelId: 2, noLink: true })
      if (result.response === 2) return false
      if (result.response === 0) await closePsmux(sessions)
      return true
    },
    begin: () => { app.isQuitting = true },
    cleanup: async () => {
      // Both run even if the first fails; services cannot be restarted after either.
      const failures: unknown[] = []
      try { await shutdownCompanion() } catch (error) { failures.push(error) }
      try { await cleanup() } catch (error) { failures.push(error) }
      if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Quit cleanup failed')
    },
    // Stopped services cannot be restored, so the app still exits; helper processes that did not
    // stop are recorded and stopped at the next start (companion/processRegistry).
    cleanupFailed: error => {
      console.error('[App] Quit cleanup failed; exiting anyway:', error)
      const chinese = storeManager.getConfig().language === 'zh-CN'
      dialog.showErrorBox(chinese ? '部分进程未能停止' : 'Some processes did not stop', (chinese ? '软件将退出，残留的工作进程会在下次启动时清理。\n' : 'DailyWorkMate will exit; leftover work processes are cleaned up at the next start.\n') + (error instanceof Error ? error.message : String(error)))
    },
    commit: () => { if (relaunchOnQuit) app.relaunch(); app.quit() },
    cancel: error => {
      quitRequested = false; app.isQuitting = false; relaunchOnQuit = false
      if (error) {
        console.error('[App] Quit confirmation failed:', error)
        const chinese = storeManager.getConfig().language === 'zh-CN'
        dialog.showErrorBox(chinese ? '未能退出' : 'Unable to quit', (chinese ? '退出确认时出现问题，软件仍保持打开，请重试。\n' : 'The quit confirmation failed. The application remains open; please retry.\n') + (error instanceof Error ? error.message : String(error)))
      }
    },
    exit: () => { console.error('[App] Quit was blocked after cleanup; exiting'); app.exit(0) },
  }))

  app.on('will-quit', () => {
    trayManager?.destroy()
  })
}

async function setupApp(): Promise<void> {
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DailyWorkMate',
    show: false,
  })

  await registerIpcHandlers(mainWindow)

  try {
    const theme = storeManager.getConfig().theme
    const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
    mainWindow.setBackgroundColor(dark ? '#09090b' : '#ffffff')
  } catch (error) { console.error('Unable to read startup theme:', error) }

  trayManager = createTrayManager(mainWindow, () => setupApp())

  await loadAppContent(mainWindow)

  if (process.env.NODE_ENV === 'development') {
    openDevTools()
  }
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

async function cleanup(): Promise<void> {
  console.log('Application is exiting, performing cleanup...')
  sessionManager.destroy()
  await internalInferenceBridge.stop()
  storeManager.flushPendingWrites()
  const updaterManager = UpdaterManager.getInstance()
  updaterManager.destroy()
}

export function restartApp(): void {
  relaunchOnQuit = true
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
