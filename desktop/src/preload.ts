import { contextBridge, ipcRenderer } from 'electron';

export type DesktopUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export type DesktopUpdateStatus = {
  state: DesktopUpdateState;
  currentVersion: string;
  availableVersion: string | null;
  message: string | null;
  progressPercent: number | null;
};

/**
 * The `window.overlord` bridge. Kept deliberately tiny: a few shell-only
 * affordances the unmodified SPA can *feature-detect* (`if (window.overlord)`),
 * never depend on. No tokens, no Node, no product logic crosses this boundary.
 */
const api = {
  /** Marks that the SPA is running inside the desktop shell. */
  isDesktop: true as const,
  platform: process.platform,
  version: process.env.OVERLORD_DESKTOP_VERSION ?? null,
  /** Open the native directory picker; resolves to an absolute path or null. */
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('overlord:choose-directory'),
  /** Open an http(s) URL in the system browser. */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:open-external', url),
  /** Reveal a path in the OS file manager. */
  revealInFinder: (path: string): Promise<boolean> => ipcRenderer.invoke('overlord:reveal', path),
  updates: {
    getStatus: (): Promise<DesktopUpdateStatus> =>
      ipcRenderer.invoke('overlord:updates:get-status'),
    check: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('overlord:updates:check'),
    install: (): Promise<DesktopUpdateStatus> => ipcRenderer.invoke('overlord:updates:install'),
    onStatus: (callback: (status: DesktopUpdateStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => {
        callback(status);
      };
      ipcRenderer.on('overlord:updates:status', listener);
      return () => {
        ipcRenderer.removeListener('overlord:updates:status', listener);
      };
    }
  }
};

export type OverlordBridge = typeof api;

contextBridge.exposeInMainWorld('overlord', api);
