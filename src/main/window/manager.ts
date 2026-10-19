import { BrowserWindow, app, shell, nativeTheme, dialog } from 'electron'
import { join } from 'path'
import { storeManager } from '../store/store'

let mainWindow: BrowserWindow | null = null

export interface WindowOptions {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  show?: boolean
}

export function createWindow(options: WindowOptions = {}): BrowserWindow {
  const {
    width = 1200,
    height = 800,
    minWidth = 800,
    minHeight = 600,
    title = 'DailyWorkMate',
    show = false,
  } = options

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
    },
    title,
    show,
    autoHideMenuBar: true,
    frame: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
    icon: app.isPackaged ? join(process.resourcesPath, 'build/icon.png') : join(app.getAppPath(), 'build/icon.png'),
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDev = process.env.NODE_ENV === 'development'
    const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
    const prodPrefix = 'file://'

    if (isDev) {
      if (!url.startsWith(devUrl)) {
        event.preventDefault()
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      }
    } else {
      if (!url.startsWith(prodPrefix)) {
        event.preventDefault()
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      }
    }
  })

  mainWindow.webContents.on('will-prevent-unload', event => {
    // A committed quit already asked about unsaved changes before stopping any service.
    if (app.isQuitting) { event.preventDefault(); return }
    const chinese = app.getLocale().startsWith('zh')
    const discard = dialog.showMessageBoxSync(mainWindow!, { type: 'question', message: chinese ? '有未保存的修改，是否放弃并离开？' : 'Discard unsaved changes and leave?', buttons: chinese ? ['继续编辑', '放弃修改'] : ['Keep editing', 'Discard'], defaultId: 0, cancelId: 0 }) === 1
    if (discard) event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      try {
        const config = storeManager.getConfig()
        if (config.minimizeToTray) {
          event.preventDefault()
          mainWindow?.hide()
        } else if (process.platform !== 'darwin') {
          event.preventDefault()
          app.quit()
        }
      } catch (error) {
        console.error('[Window] Failed to get config during close:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

// Pages register unsaved changes as beforeunload listeners; a synthetic event asks them without unloading.
const UNSAVED_PROBE = "(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()"
/**
 * Ask about unsaved changes while every service still runs, so "keep editing" cannot leave the app
 * open after cleanup. Resolves true when quitting may continue.
 */
export async function confirmDiscardUnsavedChanges(timeout = 3000): Promise<boolean> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isCrashed()) return true
  let timer: NodeJS.Timeout | undefined
  let unsaved: unknown
  try {
    unsaved = await Promise.race([window.webContents.executeJavaScript(UNSAVED_PROBE),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The page did not answer')), timeout) })])
  } catch (error) {
    // A hung or crashed page has nothing it could still save.
    console.error('[Window] Could not check for unsaved changes before quitting:', error instanceof Error ? error.message : String(error))
    return true
  } finally { clearTimeout(timer) }
  if (unsaved !== true || window.isDestroyed()) return true
  const chinese = app.getLocale().startsWith('zh')
  const { response } = await dialog.showMessageBox(window, { type: 'question', message: chinese ? '有未保存的修改，是否放弃并退出？' : 'Discard unsaved changes and quit?',
    buttons: chinese ? ['继续编辑', '放弃修改并退出'] : ['Keep editing', 'Discard and quit'], defaultId: 0, cancelId: 0, noLink: true })
  return response === 1
}

export function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  }
}

export function hideWindow(): void {
  mainWindow?.hide()
}

export function minimizeWindow(): void {
  mainWindow?.minimize()
}

export function maximizeWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
}

export function closeWindow(): void {
  mainWindow?.close()
}

export function isWindowVisible(): boolean {
  return mainWindow?.isVisible() ?? false
}

export function isWindowMaximized(): boolean {
  return mainWindow?.isMaximized() ?? false
}

export function isWindowMinimized(): boolean {
  return mainWindow?.isMinimized() ?? false
}

export function loadUrl(url: string): Promise<void> {
  return mainWindow?.loadURL(url) ?? Promise.resolve()
}

export function loadFile(filePath: string): Promise<void> {
  return mainWindow?.loadFile(filePath) ?? Promise.resolve()
}

export function reloadWindow(): void {
  mainWindow?.reload()
}

export function openDevTools(): void {
  mainWindow?.webContents.openDevTools()
}

export function closeDevTools(): void {
  mainWindow?.webContents.closeDevTools()
}

export function toggleDevTools(): void {
  mainWindow?.webContents.toggleDevTools()
}
