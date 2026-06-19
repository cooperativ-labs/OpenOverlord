import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  session
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliUpdater } from './cli-updater.js';
import { registerIpc } from './ipc.js';
import {
  hideQuickTaskWindow,
  initQuickTaskWindow,
  unregisterQuickTaskHotkey
} from './quick-task-window.js';
import { findFreePort, startServer, stopServer, waitForHealth } from './server.js';
import { DesktopUpdater } from './updater.js';
import { applyCsp, createWindow, guardNavigation } from './window.js';

loadDesktopEnvDefaults();

// `__dirname` is the dist-electron directory (esbuild emits CJS). The preload
// and splash assets are emitted alongside this bundle.
const PRELOAD = path.join(__dirname, 'preload.cjs');
const SPLASH = path.join(__dirname, 'splash.html');

const HOST = process.env.OVERLORD_WEB_HOST ?? '127.0.0.1';
const PREFERRED_PORT = parsePort(process.env.OVERLORD_WEB_PORT, 4310, 'OVERLORD_WEB_PORT');

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
  ensurePackagedConfig();
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

function loadDesktopEnvDefaults(): void {
  const envDir = app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), '..');
  const fileName = app.isPackaged ? '.env.prod' : '.env.local';
  loadEnvFile(path.join(envDir, fileName));
}

function ensurePackagedConfig(): void {
  if (!app.isPackaged) return;
  const targetPath = globalConfigPath();
  if (existsSync(targetPath)) return;

  const webHost = process.env.OVERLORD_WEB_HOST?.trim() || HOST;
  const webPort = parsePort(process.env.OVERLORD_WEB_PORT, PREFERRED_PORT, 'OVERLORD_WEB_PORT');
  const sqlStudioHost = process.env.OVERLORD_SQL_STUDIO_HOST?.trim() || '127.0.0.1';
  const sqlStudioPort = parsePort(
    process.env.OVERLORD_SQL_STUDIO_PORT,
    4311,
    'OVERLORD_SQL_STUDIO_PORT'
  );
  const sqlStudioBinary = process.env.OVERLORD_SQL_STUDIO_BINARY?.trim() || 'sql-studio';

  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    `# Overlord local instance configuration
instance_name = "Local Overlord"
backend_mode = "local"
backend_url = ${tomlString(`http://${webHost === '0.0.0.0' ? '127.0.0.1' : webHost}:${webPort}`)}
web_host = ${tomlString(webHost)}
web_port = ${webPort}
sql_studio_enabled = false
sql_studio_host = ${tomlString(sqlStudioHost)}
sql_studio_port = ${sqlStudioPort}
sql_studio_binary = ${tomlString(sqlStudioBinary)}
default_agent = "claude"
`
  );
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseEnvValue(trimmed.slice(eq + 1));
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

function parseEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && (i === 0 || value[i - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      value = value.slice(0, i).trim();
      break;
    }
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return fallback;

  const port = Number(raw);
  if (Number.isInteger(port) && port >= 0 && port < 65536) return port;

  console.warn(`[desktop] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

function globalConfigPath(): string {
  return path.join(process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld'), 'overlord.toml');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
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
