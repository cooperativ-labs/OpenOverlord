import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron';

import { isNativeThemeSource, setNativeThemeSource } from './native-theme.js';
import {
  DEFAULT_QUICK_TASK_HOTKEY,
  getStoredQuickTaskHotkey,
  hideQuickTaskWindow,
  registerQuickTaskHotkey,
  setQuickTaskWindowBounds,
  setQuickTaskWindowSize
} from './quick-task-window.js';
import type { DesktopUpdater } from './updater.js';

/**
 * The minimal, audited IPC surface exposed to the renderer through the
 * `window.overlord` preload bridge. Each handler is a genuinely shell-only
 * capability (file picking, opening things in the OS) — no product logic, no DB
 * access. The SPA feature-detects these; it never requires them.
 */
export function registerIpc({
  getWindow,
  updater,
  preloadPath
}: {
  getWindow: () => BrowserWindow | null;
  updater: DesktopUpdater;
  preloadPath: string;
}): void {
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

  ipcMain.handle('overlord:show-notification', (_event, payload: unknown) => {
    if (!Notification.isSupported()) return false;
    if (!payload || typeof payload !== 'object') return false;

    const { title, body } = payload as { title?: unknown; body?: unknown };
    if (typeof title !== 'string' || title.trim().length === 0) return false;
    if (typeof body !== 'string' || body.trim().length === 0) return false;

    new Notification({
      title: title.slice(0, 120),
      body: body.slice(0, 500)
    }).show();
    return true;
  });

  ipcMain.handle('overlord:set-native-theme-source', (_event, source: unknown) => {
    if (!isNativeThemeSource(source)) return false;
    setNativeThemeSource(source);
    return true;
  });

  ipcMain.handle('overlord:updates:get-status', () => updater.getStatus());
  ipcMain.handle('overlord:updates:check', () => updater.checkForUpdates());
  ipcMain.handle('overlord:updates:install', () => updater.installDownloadedUpdate());

  ipcMain.handle('overlord:quick-task:get-hotkey', () => ({
    accelerator: getStoredQuickTaskHotkey(),
    defaultAccelerator: DEFAULT_QUICK_TASK_HOTKEY
  }));

  ipcMain.handle('overlord:quick-task:set-hotkey', (_event, accelerator: unknown) => {
    if (typeof accelerator !== 'string') {
      return { ok: false, accelerator: getStoredQuickTaskHotkey(), error: 'Invalid accelerator' };
    }
    return registerQuickTaskHotkey({ preloadPath, accelerator });
  });

  ipcMain.handle('overlord:quick-task:close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.hide();
    } else {
      hideQuickTaskWindow();
    }
    return true;
  });

  ipcMain.handle('overlord:quick-task:set-height', (_event, height: unknown) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      setQuickTaskWindowSize(height);
    }
    return true;
  });

  ipcMain.handle(
    'overlord:quick-task:set-bounds',
    (_event, args: { height: number; barOffsetTop: number }) => {
      if (
        args &&
        typeof args.height === 'number' &&
        Number.isFinite(args.height) &&
        typeof args.barOffsetTop === 'number' &&
        Number.isFinite(args.barOffsetTop)
      ) {
        setQuickTaskWindowBounds(args);
      }
      return true;
    }
  );
}
