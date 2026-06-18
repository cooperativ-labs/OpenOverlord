import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  session
} from 'electron';
import path from 'node:path';

import { registerIpc } from './ipc.js';
import {
  hideQuickTaskWindow,
  initQuickTaskWindow,
  unregisterQuickTaskHotkey
} from './quick-task-window.js';
import { findFreePort, startServer, stopServer, waitForHealth } from './server.js';
import { CliUpdater } from './cli-updater.js';
import { DesktopUpdater } from './updater.js';
import { applyCsp, createWindow, guardNavigation } from './window.js';

// `__dirname` is the dist-electron directory (esbuild emits CJS). The preload
// and splash assets are emitted alongside this bundle.
const PRELOAD = path.join(__dirname, 'preload.cjs');
const SPLASH = path.join(__dirname, 'splash.html');

const HOST = process.env.OVERLORD_WEB_HOST ?? '127.0.0.1';
const PREFERRED_PORT = Number(process.env.OVERLORD_WEB_PORT ?? '4310');

// Dev: connect to an already-running server (`yarn start` / `ovld serve`) instead
// of forking the bundle, so a dev loop needs no Electron-ABI native rebuild.
const DEV_CONNECT = process.env.OVERLORD_DESKTOP_DEV === '1';
const DEV_URL = process.env.OVERLORD_DESKTOP_URL ?? `http://${HOST}:${PREFERRED_PORT}`;

let mainWindow: BrowserWindow | null = null;
let appOrigin = `http://${HOST}:${PREFERRED_PORT}`;
let updater: DesktopUpdater | null = null;
let cliUpdater: CliUpdater | null = null;

// Expose the version to the preload bridge.
process.env.OVERLORD_DESKTOP_VERSION = app.getVersion();

// Single-instance lock: focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(boot)
    .catch(error => {
      dialog.showErrorBox('Overlord failed to start', describe(error));
      app.quit();
    });
}

async function boot(): Promise<void> {
  updater = new DesktopUpdater(() => mainWindow);
  cliUpdater = new CliUpdater(() => mainWindow);
  installApplicationMenu(updater);
  registerIpc({
    getWindow: () => mainWindow,
    updater,
    cliUpdater,
    preloadPath: PRELOAD
  });

  // In connect-only dev mode the origin is the running dev server; otherwise we
  // claim a free loopback port and the supervised server binds to it.
  appOrigin = DEV_CONNECT
    ? new URL(DEV_URL).origin
    : `http://${HOST}:${await findFreePort(PREFERRED_PORT, HOST)}`;

  applyCsp(session.defaultSession, appOrigin);

  await openMainWindow();
  initQuickTaskWindow({ appOrigin, preloadPath: PRELOAD });
  updater.startAutomaticChecks();
  cliUpdater.startAutomaticChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
  });
}

async function openMainWindow(): Promise<void> {
  mainWindow = createWindow(PRELOAD);
  guardNavigation(mainWindow, appOrigin);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(SPLASH);

  if (!DEV_CONNECT) startServer({ host: HOST, port: portOf(appOrigin) });

  const healthy = await waitForHealth({ host: hostOf(appOrigin), port: portOf(appOrigin) });
  if (!mainWindow) return;

  if (healthy) {
    await mainWindow.loadURL(`${appOrigin}/`);
  } else {
    await showStartupError();
  }
}

async function showStartupError(): Promise<void> {
  if (!mainWindow) return;
  const message = DEV_CONNECT
    ? `Could not reach the Overlord dev server at ${appOrigin}.\nStart it with \`ovld serve\` (or \`yarn start\`) and retry.`
    : `The Overlord server did not become ready at ${appOrigin}.`;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Overlord',
    message: 'Overlord could not start',
    detail: message,
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1
  });
  if (response === 0) {
    const healthy = await waitForHealth({
      host: hostOf(appOrigin),
      port: portOf(appOrigin),
      timeoutMs: 15_000
    });
    if (healthy && mainWindow) await mainWindow.loadURL(`${appOrigin}/`);
    else if (mainWindow) await showStartupError();
  } else {
    app.quit();
  }
}

app.on('before-quit', () => {
  updater?.stopAutomaticChecks();
  cliUpdater?.stopAutomaticChecks();
  unregisterQuickTaskHotkey();
  hideQuickTaskWindow();
  stopServer();
});

app.on('window-all-closed', () => {
  // A wrapper around a single web UI: closing the window quits the app (and the
  // supervised server via `before-quit`) on every platform.
  app.quit();
});

function installApplicationMenu(updater: DesktopUpdater): void {
  const isMac = process.platform === 'darwin';
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates...',
    click: () => {
      void updater.checkForUpdatesWithDialog();
    }
  };
  const installUpdateItem: MenuItemConstructorOptions = {
    label: 'Install Update and Relaunch',
    click: () => {
      void updater.showInstallDialog();
    }
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              checkForUpdatesItem,
              installUpdateItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : ([] as MenuItemConstructorOptions[])),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(!isMac
      ? ([
          {
            role: 'help',
            submenu: [checkForUpdatesItem, installUpdateItem]
          }
        ] as MenuItemConstructorOptions[])
      : ([] as MenuItemConstructorOptions[]))
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hostOf(origin: string): string {
  return new URL(origin).hostname;
}

function portOf(origin: string): number {
  const { port } = new URL(origin);
  return port ? Number(port) : 80;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
