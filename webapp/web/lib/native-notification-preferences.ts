const STORAGE_KEY = 'overlord-native-notifications-enabled';
const CHANGE_EVENT = 'overlord-native-notifications-change';

export function isNativeNotificationsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'false') return false;
  } catch {
    // localStorage may be unavailable in rare embed contexts.
  }
  return true;
}

export function setNativeNotificationsEnabled({ enabled }: { enabled: boolean }): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // localStorage may be unavailable in rare embed contexts.
  }
}

export function subscribeNativeNotificationsEnabled(
  listener: (enabled: boolean) => void
): () => void {
  const handler = () => listener(isNativeNotificationsEnabled());
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
