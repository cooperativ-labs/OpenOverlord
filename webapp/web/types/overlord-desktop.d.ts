export {};

declare global {
  type DesktopUpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported';

  type DesktopUpdateStatus = {
    state: DesktopUpdateState;
    currentVersion: string;
    availableVersion: string | null;
    message: string | null;
    progressPercent: number | null;
  };

  type OverlordDesktopBridge = {
    isDesktop: true;
    platform: NodeJS.Platform;
    version: string | null;
    chooseDirectory: () => Promise<string | null>;
    openExternal: (url: string) => Promise<boolean>;
    revealInFinder: (path: string) => Promise<boolean>;
    showNotification?: (payload: { title: string; body: string; tag?: string }) => Promise<boolean>;
    setNativeThemeSource?: (source: 'light' | 'dark' | 'system') => Promise<boolean>;
    quickTask?: {
      getHotkey: () => Promise<{ accelerator: string; defaultAccelerator: string }>;
      setHotkey: (
        accelerator: string
      ) => Promise<{ ok: boolean; accelerator: string; error?: string }>;
      close: () => Promise<void>;
      setHeight: (height: number) => Promise<void>;
      setBounds?: (args: { height: number; barOffsetTop: number }) => Promise<void>;
      onShown: (callback: () => void) => () => void;
    };
    updates: {
      getStatus: () => Promise<DesktopUpdateStatus>;
      check: () => Promise<DesktopUpdateStatus>;
      install: () => Promise<DesktopUpdateStatus>;
      onStatus: (callback: (status: DesktopUpdateStatus) => void) => () => void;
    };
  };

  interface Window {
    overlord?: OverlordDesktopBridge;
  }
}
