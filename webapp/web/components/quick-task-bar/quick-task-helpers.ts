export type ProjectOption = {
  id: string;
  name: string;
  color: string | null;
  /** Owning workspace, so pickers can group and catalogs can scope (coo:324). */
  workspaceId: string;
  workspaceName: string | null;
};

export type StagedFile = {
  id: string;
  file: File;
};

export type QuickTaskWindowApi = {
  close: () => Promise<void>;
  setHeight: (height: number) => Promise<void>;
  setBounds?: (args: { height: number; barOffsetTop: number }) => Promise<void>;
  onShown: (callback: () => void) => () => void;
  getHotkey: () => Promise<{ accelerator: string; defaultAccelerator: string }>;
  setHotkey: (accelerator: string) => Promise<{ ok: boolean; accelerator: string; error?: string }>;
};

export type IdleCallbackHandle = number;
export type IdleDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};
export type IdleScheduler = {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout: number }
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

export function getQuickTaskApi(): QuickTaskWindowApi | null {
  if (typeof window === 'undefined') return null;
  return window.overlord?.quickTask ?? null;
}

export function resolveProjectId(
  projects: ProjectOption[],
  defaultProjectId: string | null
): string {
  if (defaultProjectId && projects.some(project => project.id === defaultProjectId)) {
    return defaultProjectId;
  }
  return projects[0]?.id ?? '';
}
