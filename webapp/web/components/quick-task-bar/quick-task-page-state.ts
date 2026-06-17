const QUICK_TASK_DEFAULT_PROJECT_KEY = 'overlord.quickTask.defaultProjectId';

export function readStoredDefaultProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(QUICK_TASK_DEFAULT_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function writeStoredDefaultProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(QUICK_TASK_DEFAULT_PROJECT_KEY, projectId);
  } catch {
    // ignore quota / private mode
  }
}
