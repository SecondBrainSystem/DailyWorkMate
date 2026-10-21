import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Native Copy works for ordinary selected UI text as well as message bodies and editable fields. */
export function registerCopyContextMenu(window: BrowserWindow, chinese: () => boolean): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.selectionText && !params.isEditable) return
    const zh = chinese()
    const items: MenuItemConstructorOptions[] = [
      ...(params.isEditable ? [{ role: 'cut' as const, label: zh ? '剪切' : 'Cut', enabled: params.editFlags.canCut }] : []),
      { role: 'copy', label: zh ? '复制' : 'Copy', enabled: !!params.selectionText || params.editFlags.canCopy },
      ...(params.isEditable ? [
        { role: 'paste' as const, label: zh ? '粘贴' : 'Paste', enabled: params.editFlags.canPaste },
        { type: 'separator' as const },
        { role: 'selectAll' as const, label: zh ? '全选' : 'Select all' },
      ] : []),
    ]
    Menu.buildFromTemplate(items).popup({ window })
  })
}
