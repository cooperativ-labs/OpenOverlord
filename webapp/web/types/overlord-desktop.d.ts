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

  type CliUpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'updating'
    | 'error'
    | 'unsupported';

  type CliUpdateStatus = {
    state: CliUpdateState;
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    message: string | null;
    updateCommand: string;
  };

  type DesktopBackendMode = 'local' | 'remote';

  type DesktopBackendInfo = {
    id: string;
    label: string;
    mode: DesktopBackendMode;
    backendUrl: string;
    apiBaseUrl: string;
    shellOrigin: string;
  };

  type DesktopBackendProfile = {
    id: string;
    label: string;
    mode: DesktopBackendMode;
    backendUrl: string;
  };

  type OverlordDesktopBridge = {
    isDesktop: true;
    platform: NodeJS.Platform;
    version: string | null;
    chooseDirectory: () => Promise<string | null>;
    getDeviceIdentity?: () => Promise<{
      deviceFingerprint: string;
      deviceLabel: string;
      devicePlatform: string;
    }>;
    invokeLocalTarget?: (
      call: import('../../packages/core/service/local-target/desktop-bridge.ts').LocalTargetBridgeCall
    ) => Promise<
      import('../../packages/core/service/local-target/types.ts').CapabilityResult<unknown>
    >;
    writeProjectMetadata?: (payload: {
      directoryPath: string;
      projectId: string;
      resourceId: string;
      isPrimary: boolean;
    }) => Promise<boolean>;
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
    cliUpdates?: {
      getStatus: () => Promise<CliUpdateStatus>;
      check: () => Promise<CliUpdateStatus>;
      update: () => Promise<CliUpdateStatus>;
      onStatus: (callback: (status: CliUpdateStatus) => void) => () => void;
    };
    getActiveBackend?: () => Promise<DesktopBackendInfo>;
    listBackends?: () => Promise<DesktopBackendProfile[]>;
    addBackend?: (payload: {
      label: string;
      backendUrl: string;
    }) => Promise<DesktopBackendProfile>;
    removeBackend?: (id: string) => Promise<boolean>;
    switchBackend?: (id: string) => Promise<DesktopBackendInfo>;
    getBearerToken?: (profileId: string) => Promise<string | null>;
    setBearerToken?: (payload: { profileId: string; token: string }) => Promise<boolean>;
    clearBearerToken?: (profileId: string) => Promise<boolean>;
    getSessionToken?: (profileId: string) => Promise<string | null>;
    setSessionToken?: (payload: { profileId: string; token: string }) => Promise<boolean>;
    clearSessionToken?: (profileId: string) => Promise<boolean>;
  };

  interface Window {
    overlord?: OverlordDesktopBridge;
  }
}
