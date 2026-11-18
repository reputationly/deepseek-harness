/** Native edit menu for text fields and selected text, shared by every desktop window. */
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { DesktopMessages } from './locale.ts'

/**
 * Attach the cut/copy/paste menu Electron leaves out of its default rendering.
 *
 * Without it a password or key field offers no right-click paste, so a user who does
 * not know the shortcut cannot enter a key at all.
 * @param window - window whose web contents own the menu.
 * @param messages - resolves the shell dictionary in effect when the menu opens.
 * @param platform - operating system whose role labels the shell localizes.
 */
export function installEditContextMenu(
  window: BrowserWindow,
  messages: () => DesktopMessages,
  platform: NodeJS.Platform = process.platform,
): void {
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    if (items.length === 0) return
    const dictionary = messages()
    Menu.buildFromTemplate(items.map(item => ({
      ...item,
      // Empty accelerators suppress Electron's default shortcut labels for native roles.
      ...(platform === 'win32' && item.role !== undefined && item.role in dictionary
        ? { label: dictionary[item.role as keyof typeof dictionary] }
        : {}),
      accelerator: '',
    }))).popup({ window })
  })
}
