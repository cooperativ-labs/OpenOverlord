import { BrowserWindow, globalShortcut, screen, session } from 'electron';

import { store } from './settings-store.js';

const SETTINGS_KEY = 'quickTaskHotkey';
const POSITION_SETTINGS_KEY = 'quickTaskWindowPosition';
export const DEFAULT_QUICK_TASK_HOTKEY = 'CommandOrControl+Shift+O';

const WINDOW_WIDTH = 620;
const INITIAL_WINDOW_HEIGHT = 150;

type SavedPosition = { x: number; y: number };

function readSavedPosition(): SavedPosition | null {
  const raw = store.get(POSITION_SETTINGS_KEY);
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as SavedPosition).x === 'number' &&
    typeof (raw as SavedPosition).y === 'number'
  ) {
    return { x: (raw as SavedPosition).x, y: (raw as SavedPosition).y };
  }
  return null;
}

function writeSavedPosition(position: SavedPosition): void {
  store.set(POSITION_SETTINGS_KEY, position);
}

function getValidatedSavedPosition(width: number, height: number): SavedPosition | null {
  const saved = readSavedPosition();
  if (!saved) return null;
  const displays = screen.getAllDisplays();
  const fits = displays.some(display => {
    const { x, y, width: dw, height: dh } = display.workArea;
    return saved.x + width > x && saved.x < x + dw && saved.y + height > y && saved.y < y + dh;
  });
  return fits ? saved : null;
}

function getCursorDisplayPosition(width: number): SavedPosition {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { workArea } = display;
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round(workArea.height * 0.18)
  };
}

let quickWindow: BrowserWindow | null = null;
let registeredAccelerator: string | null = null;
let baseUrl = '';
let quickTaskBlurHideTimer: ReturnType<typeof setTimeout> | null = null;
let barAnchorScreenY: number | null = null;
let suppressMovedReset = false;

const QUICK_TASK_BLUR_HIDE_MS = 180;

function isReservedAccelerator(accel: string): boolean {
  return accel.trim().length === 0;
}

function setQuickTaskHotkeySuspended(suspended: boolean): void {
  if (globalShortcut.isSuspended() === suspended) return;
  globalShortcut.setSuspended(suspended);
}

export function getStoredQuickTaskHotkey(): string {
  const value = store.get(SETTINGS_KEY);
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return DEFAULT_QUICK_TASK_HOTKEY;
}

export function setStoredQuickTaskHotkey(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const next = trimmed.length > 0 ? trimmed : DEFAULT_QUICK_TASK_HOTKEY;
  store.set(SETTINGS_KEY, next);
  return next;
}

function getQuickTaskUrl(): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}/quick-task`;
}

function ensureWindow(preloadPath: string): BrowserWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow;

  const initial =
    getValidatedSavedPosition(WINDOW_WIDTH, INITIAL_WINDOW_HEIGHT) ??
    getCursorDisplayPosition(WINDOW_WIDTH);

  quickWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: INITIAL_WINDOW_HEIGHT,
    x: initial.x,
    y: initial.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    title: 'Quick Task',
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  quickWindow.setAlwaysOnTop(true, 'screen-saver');
  quickWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });

  quickWindow.loadURL(getQuickTaskUrl());

  quickWindow.on('blur', () => {
    const win = quickWindow;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (quickTaskBlurHideTimer) {
      clearTimeout(quickTaskBlurHideTimer);
      quickTaskBlurHideTimer = null;
    }
    quickTaskBlurHideTimer = setTimeout(() => {
      quickTaskBlurHideTimer = null;
      if (!win.isDestroyed() && win.isVisible() && !win.isFocused()) {
        win.hide();
      }
    }, QUICK_TASK_BLUR_HIDE_MS);
  });

  quickWindow.on('focus', () => {
    if (quickTaskBlurHideTimer) {
      clearTimeout(quickTaskBlurHideTimer);
      quickTaskBlurHideTimer = null;
    }
  });

  quickWindow.on('moved', () => {
    const win = quickWindow;
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    writeSavedPosition({ x, y });
    if (!suppressMovedReset) {
      barAnchorScreenY = null;
    }
  });

  quickWindow.on('closed', () => {
    if (quickTaskBlurHideTimer) {
      clearTimeout(quickTaskBlurHideTimer);
      quickTaskBlurHideTimer = null;
    }
    quickWindow = null;
  });

  return quickWindow;
}

function showQuickTaskWindow(preloadPath: string): void {
  const window = ensureWindow(preloadPath);
  if (window.isVisible()) {
    window.focus();
    return;
  }

  const [, currentHeight] = window.getSize();
  const target =
    getValidatedSavedPosition(WINDOW_WIDTH, currentHeight) ??
    getCursorDisplayPosition(WINDOW_WIDTH);
  window.setPosition(target.x, target.y, false);
  barAnchorScreenY = null;

  if (window.webContents.getURL() !== getQuickTaskUrl()) {
    window.loadURL(getQuickTaskUrl());
  }
  window.show();
  window.focus();
  window.webContents.send('overlord:quick-task-shown');
}

export function hideQuickTaskWindow(): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide();
  }
}

export function toggleQuickTaskWindow(preloadPath: string): void {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide();
    return;
  }
  showQuickTaskWindow(preloadPath);
}

const QUICK_TASK_MIN_HEIGHT = 120;
const QUICK_TASK_DISPLAY_MARGIN = 80;

function getQuickTaskMaxHeight(window: BrowserWindow): number {
  try {
    const [x, y] = window.getPosition();
    const display = screen.getDisplayNearestPoint({ x, y });
    return Math.max(QUICK_TASK_MIN_HEIGHT, display.workArea.height - QUICK_TASK_DISPLAY_MARGIN);
  } catch {
    return 800;
  }
}

export function setQuickTaskWindowSize(height: number): void {
  if (!quickWindow || quickWindow.isDestroyed()) return;
  const max = getQuickTaskMaxHeight(quickWindow);
  const clamped = Math.max(QUICK_TASK_MIN_HEIGHT, Math.min(max, Math.round(height)));
  const [width] = quickWindow.getSize();
  quickWindow.setSize(width ?? WINDOW_WIDTH, clamped, false);
}

export function setQuickTaskWindowBounds(args: { height: number; barOffsetTop: number }): void {
  if (!quickWindow || quickWindow.isDestroyed()) return;
  const win = quickWindow;
  const max = getQuickTaskMaxHeight(win);
  const clampedHeight = Math.max(QUICK_TASK_MIN_HEIGHT, Math.min(max, Math.round(args.height)));
  const [width] = win.getSize();
  const [x, currentY] = win.getPosition();

  if (barAnchorScreenY === null) {
    barAnchorScreenY = currentY + args.barOffsetTop;
  }

  let nextY = Math.round(barAnchorScreenY - args.barOffsetTop);

  const display = screen.getDisplayNearestPoint({ x, y: nextY });
  const minY = display.workArea.y;
  const maxY = display.workArea.y + display.workArea.height - clampedHeight;
  if (nextY < minY || nextY > maxY) {
    nextY = Math.max(minY, Math.min(maxY, nextY));
    barAnchorScreenY = nextY + args.barOffsetTop;
  }

  suppressMovedReset = true;
  win.setBounds({ x, y: nextY, width: width ?? WINDOW_WIDTH, height: clampedHeight }, false);
  setImmediate(() => {
    suppressMovedReset = false;
  });
}

export function registerQuickTaskHotkey({
  preloadPath,
  accelerator
}: {
  preloadPath: string;
  accelerator?: string;
}): {
  ok: boolean;
  accelerator: string;
  error?: string;
} {
  const target = (accelerator ?? getStoredQuickTaskHotkey()).trim();
  const wasSuspended = globalShortcut.isSuspended();

  if (registeredAccelerator === target) {
    try {
      setQuickTaskHotkeySuspended(false);
    } catch (error) {
      return {
        ok: false,
        accelerator: target,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    setStoredQuickTaskHotkey(target);
    return { ok: true, accelerator: target };
  }

  if (isReservedAccelerator(target)) {
    return { ok: false, accelerator: target, error: 'Empty accelerator' };
  }

  let previousAccelerator: string | null = null;
  if (registeredAccelerator) {
    try {
      setQuickTaskHotkeySuspended(false);
      globalShortcut.unregister(registeredAccelerator);
      previousAccelerator = registeredAccelerator;
    } catch {
      // ignore
    }
    registeredAccelerator = null;
  }

  let ok: boolean;
  try {
    ok = globalShortcut.register(target, () => {
      toggleQuickTaskWindow(preloadPath);
    });
  } catch (error) {
    return {
      ok: false,
      accelerator: target,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (!ok) {
    if (previousAccelerator) {
      try {
        const restored = globalShortcut.register(previousAccelerator, () => {
          toggleQuickTaskWindow(preloadPath);
        });
        if (restored) {
          registeredAccelerator = previousAccelerator;
        }
      } catch {
        // ignore restore failure
      }
    }

    if (wasSuspended && registeredAccelerator) {
      try {
        setQuickTaskHotkeySuspended(true);
      } catch {
        // ignore
      }
    }

    return {
      ok: false,
      accelerator: target,
      error: 'Failed to register accelerator (already in use?)'
    };
  }

  registeredAccelerator = target;
  if (wasSuspended) {
    setQuickTaskHotkeySuspended(true);
  }
  setStoredQuickTaskHotkey(target);
  return { ok: true, accelerator: target };
}

export function unregisterQuickTaskHotkey(): void {
  if (registeredAccelerator) {
    try {
      setQuickTaskHotkeySuspended(false);
      globalShortcut.unregister(registeredAccelerator);
    } catch {
      // ignore
    }
    registeredAccelerator = null;
  }
}

export function initQuickTaskWindow({
  appOrigin,
  preloadPath
}: {
  appOrigin: string;
  preloadPath: string;
}): void {
  baseUrl = appOrigin;
  void session.defaultSession;
  ensureWindow(preloadPath);
  registerQuickTaskHotkey({ preloadPath });
}
