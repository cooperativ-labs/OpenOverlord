import { safeStorage } from 'electron';

import { store } from './settings-store.js';

function storageKey(profileId: string): string {
  return `backendBearerToken:${profileId}`;
}

export function getBearerToken(profileId: string): string | null {
  const encrypted = store.get(storageKey(profileId));
  if (typeof encrypted !== 'string' || encrypted.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

export function setBearerToken({ profileId, token }: { profileId: string; token: string }): void {
  const trimmed = token.trim();
  if (!trimmed) {
    clearBearerToken(profileId);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system.');
  }
  store.set(storageKey(profileId), safeStorage.encryptString(trimmed).toString('base64'));
}

export function clearBearerToken(profileId: string): void {
  store.delete(storageKey(profileId));
}
