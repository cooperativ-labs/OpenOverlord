import { BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';

import {
  addRemoteBackend,
  type BackendRuntimeController,
  clearBearerTokenForProfile,
  clearSessionTokenForProfile,
  getPublicActiveBackend,
  listPublicBackends,
  readBearerTokenForProfile,
  readSessionTokenForProfile,
  removeRemoteBackend,
  switchActiveBackend,
  writeBearerTokenForProfile,
  writeSessionTokenForProfile
} from './backend-runtime.js';
import type { CliUpdater } from './cli-updater.js';
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
  cliUpdater,
  preloadPath,
  getShellOrigin,
  getBackendController
}: {
  getWindow: () => BrowserWindow | null;
  updater: DesktopUpdater;
  cliUpdater: CliUpdater;
  preloadPath: string;
  getShellOrigin: () => string;
  getBackendController: () => BackendRuntimeController | null;
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

  ipcMain.handle('overlord:cli-updates:get-status', () => cliUpdater.getStatus());
  ipcMain.handle('overlord:cli-updates:check', () => cliUpdater.checkForUpdates());
  ipcMain.handle('overlord:cli-updates:update', () => cliUpdater.runUpdate());

  ipcMain.handle('overlord:backend:get-active', () =>
    getPublicActiveBackend({ shellOrigin: getShellOrigin() })
  );

  ipcMain.handle('overlord:backend:list', () =>
    listPublicBackends({ shellOrigin: getShellOrigin() })
  );

  ipcMain.handle(
    'overlord:backend:add',
    (_event, payload: { label?: unknown; backendUrl?: unknown }) => {
      if (typeof payload?.label !== 'string' || typeof payload?.backendUrl !== 'string') {
        throw new Error('Backend label and URL are required.');
      }
      return addRemoteBackend({ label: payload.label, backendUrl: payload.backendUrl });
    }
  );

  ipcMain.handle('overlord:backend:remove', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Backend profile id is required.');
    }
    removeRemoteBackend(id);
    return true;
  });

  ipcMain.handle('overlord:backend:switch', async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Backend profile id is required.');
    }
    const controller = getBackendController();
    if (!controller) {
      throw new Error('Backend controller is not ready.');
    }
    await switchActiveBackend({ id, controller });
    return getPublicActiveBackend({ shellOrigin: getShellOrigin() });
  });

  ipcMain.handle('overlord:backend:get-bearer-token', (_event, profileId: unknown) => {
    if (typeof profileId !== 'string' || profileId.length === 0) return null;
    return readBearerTokenForProfile(profileId);
  });

  ipcMain.handle(
    'overlord:backend:set-bearer-token',
    (_event, payload: { profileId?: unknown; token?: unknown }) => {
      if (typeof payload?.profileId !== 'string' || typeof payload?.token !== 'string') {
        throw new Error('Profile id and token are required.');
      }
      writeBearerTokenForProfile({ profileId: payload.profileId, token: payload.token });
      return true;
    }
  );

  ipcMain.handle('overlord:backend:clear-bearer-token', (_event, profileId: unknown) => {
    if (typeof profileId !== 'string' || profileId.length === 0) return false;
    clearBearerTokenForProfile(profileId);
    return true;
  });

  ipcMain.handle('overlord:backend:get-session-token', (_event, profileId: unknown) => {
    if (typeof profileId !== 'string' || profileId.length === 0) return null;
    return readSessionTokenForProfile(profileId);
  });

  ipcMain.handle(
    'overlord:backend:set-session-token',
    (_event, payload: { profileId?: unknown; token?: unknown }) => {
      if (typeof payload?.profileId !== 'string' || typeof payload?.token !== 'string') {
        throw new Error('Profile id and token are required.');
      }
      writeSessionTokenForProfile({ profileId: payload.profileId, token: payload.token });
      return true;
    }
  );

  ipcMain.handle('overlord:backend:clear-session-token', (_event, profileId: unknown) => {
    if (typeof profileId !== 'string' || profileId.length === 0) return false;
    clearSessionTokenForProfile(profileId);
    return true;
  });

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
