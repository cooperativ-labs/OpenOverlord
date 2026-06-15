import { type BrowserWindow, dialog, ipcMain, shell } from 'electron';

/**
 * The minimal, audited IPC surface exposed to the renderer through the
 * `window.overlord` preload bridge. Each handler is a genuinely shell-only
 * capability (file picking, opening things in the OS) — no product logic, no DB
 * access. The SPA feature-detects these; it never requires them.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // Pick a local directory (e.g. to link a project to a checkout).
  ipcMain.handle('overlord:choose-directory', async () => {
    const window = getWindow();
    const properties: Array<'openDirectory' | 'createDirectory'> = [
      'openDirectory',
      'createDirectory'
    ];
    const options = { title: 'Choose a project directory', properties };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Open an external URL in the system browser. Only http(s) is allowed so the
  // renderer can never ask us to launch arbitrary schemes (file:, etc.).
  ipcMain.handle('overlord:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    } catch {
      return false;
    }
    await shell.openExternal(url);
    return true;
  });

  // Reveal a path in the OS file manager (Finder).
  ipcMain.handle('overlord:reveal', (_event, targetPath: unknown) => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });
}
