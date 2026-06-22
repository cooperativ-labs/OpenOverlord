const LAST_USED_PROJECT_KEY = 'overlord:lastUsedProjectId';

export function readLastUsedProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_USED_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function writeLastUsedProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_USED_PROJECT_KEY, projectId);
  } catch {
    // ignore quota / private mode
  }
}
