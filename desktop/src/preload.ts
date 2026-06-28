import { contextBridge, ipcRenderer } from 'electron';

import type { LocalTargetBridgeCall } from '../../packages/core/service/local-target/desktop-bridge.ts';
import type { CapabilityResult } from '../../packages/core/service/local-target/types.ts';

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

export type CliUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'updating'
  | 'error'
  | 'unsupported';

export type CliUpdateStatus = {
  state: CliUpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string | null;
  updateCommand: string;
};

export type DesktopBackendMode = 'local' | 'remote';

export type DesktopBackendInfo = {
  id: string;
  label: string;
  mode: DesktopBackendMode;
  backendUrl: string;
  apiBaseUrl: string;
  shellOrigin: string;
};

export type DesktopBackendProfile = {
  id: string;
  label: string;
  mode: DesktopBackendMode;
  backendUrl: string;
};

/**
 * The `window.overlord` bridge. Kept deliberately tiny: a few shell-only
 * affordances the unmodified SPA can *feature-detect* (`if (window.overlord)`),
 * never depend on. No tokens, no Node, no DB access crosses this boundary.
 */
const api = {
  /** Marks that the SPA is running inside the desktop shell. */
  isDesktop: true as const,
  platform: process.platform,
  version: process.env.OVERLORD_DESKTOP_VERSION ?? null,
  /** Open the native directory picker; resolves to an absolute path or null. */
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('overlord:choose-directory'),
  /** Stable device fingerprint for this machine (matches the CLI runner). */
  getDeviceIdentity: (): Promise<{
    deviceFingerprint: string;
    deviceLabel: string;
    devicePlatform: string;
  }> => ipcRenderer.invoke('overlord:device-identity'),
  /** Unified local-target capability bridge for checkout-local git/fs work. */
  invokeLocalTarget: (call: LocalTargetBridgeCall): Promise<CapabilityResult<unknown>> =>
    ipcRenderer.invoke('overlord:invoke-local-target', call),
  /** Write local `.overlord/project.json` metadata for a linked checkout. */
  writeProjectMetadata: (payload: {
    directoryPath: string;
    projectId: string;
    resourceId: string;
    isPrimary: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('overlord:write-project-metadata', payload),
  /** Open an http(s) URL in the system browser. */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:open-external', url),
  /** Reveal a path in the OS file manager. */
  revealInFinder: (path: string): Promise<boolean> => ipcRenderer.invoke('overlord:reveal', path),
  /** Show a native desktop notification. */
  showNotification: (payload: { title: string; body: string; tag?: string }): Promise<boolean> =>
    ipcRenderer.invoke('overlord:show-notification', payload),
  /** Sync Electron nativeTheme with the SPA theme (macOS vibrancy follows this). */
  setNativeThemeSource: (source: 'light' | 'dark' | 'system'): Promise<boolean> =>
    ipcRenderer.invoke('overlord:set-native-theme-source', source),
  quickTask: {
    getHotkey: (): Promise<{ accelerator: string; defaultAccelerator: string }> =>
      ipcRenderer.invoke('overlord:quick-task:get-hotkey'),
    setHotkey: (
      accelerator: string
    ): Promise<{ ok: boolean; accelerator: string; error?: string }> =>
      ipcRenderer.invoke('overlord:quick-task:set-hotkey', accelerator),
    close: (): Promise<void> => ipcRenderer.invoke('overlord:quick-task:close'),
    setHeight: (height: number): Promise<void> =>
      ipcRenderer.invoke('overlord:quick-task:set-height', height),
    setBounds: (args: { height: number; barOffsetTop: number }): Promise<void> =>
      ipcRenderer.invoke('overlord:quick-task:set-bounds', args),
    onShown: (callback: () => void): (() => void) => {
      const listener = () => {
        callback();
      };
      ipcRenderer.on('overlord:quick-task-shown', listener);
      return () => {
        ipcRenderer.removeListener('overlord:quick-task-shown', listener);
      };
    }
  },
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
  },
  cliUpdates: {
    getStatus: (): Promise<CliUpdateStatus> =>
      ipcRenderer.invoke('overlord:cli-updates:get-status'),
    check: (): Promise<CliUpdateStatus> => ipcRenderer.invoke('overlord:cli-updates:check'),
    update: (): Promise<CliUpdateStatus> => ipcRenderer.invoke('overlord:cli-updates:update'),
    onStatus: (callback: (status: CliUpdateStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: CliUpdateStatus) => {
        callback(status);
      };
      ipcRenderer.on('overlord:cli-updates:status', listener);
      return () => {
        ipcRenderer.removeListener('overlord:cli-updates:status', listener);
      };
    }
  },
  getActiveBackend: (): Promise<DesktopBackendInfo> =>
    ipcRenderer.invoke('overlord:backend:get-active'),
  listBackends: (): Promise<DesktopBackendProfile[]> => ipcRenderer.invoke('overlord:backend:list'),
  addBackend: (payload: { label: string; backendUrl: string }): Promise<DesktopBackendProfile> =>
    ipcRenderer.invoke('overlord:backend:add', payload),
  removeBackend: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:backend:remove', id),
  switchBackend: (id: string): Promise<DesktopBackendInfo> =>
    ipcRenderer.invoke('overlord:backend:switch', id),
  getBearerToken: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke('overlord:backend:get-bearer-token', profileId),
  setBearerToken: (payload: { profileId: string; token: string }): Promise<boolean> =>
    ipcRenderer.invoke('overlord:backend:set-bearer-token', payload),
  clearBearerToken: (profileId: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:backend:clear-bearer-token', profileId),
  getSessionToken: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke('overlord:backend:get-session-token', profileId),
  setSessionToken: (payload: { profileId: string; token: string }): Promise<boolean> =>
    ipcRenderer.invoke('overlord:backend:set-session-token', payload),
  clearSessionToken: (profileId: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:backend:clear-session-token', profileId)
};

export type OverlordBridge = typeof api;

contextBridge.exposeInMainWorld('overlord', api);
