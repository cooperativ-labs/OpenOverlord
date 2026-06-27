import { randomUUID } from 'node:crypto';

import { store } from './settings-store.js';

export type BackendMode = 'local' | 'remote';

export type BackendProfile = {
  id: string;
  label: string;
  mode: BackendMode;
  backendUrl: string;
};

export type ActiveBackend = {
  id: string;
  label: string;
  mode: BackendMode;
  /** Loopback origin the SPA shell loads from. */
  shellOrigin: string;
  /** REST/realtime/auth base URL the SPA should call. Empty means same as shell. */
  apiBaseUrl: string;
};

export const LOCAL_BACKEND_PROFILE_ID = 'local';

const PROFILES_KEY = 'backendProfiles';
const ACTIVE_PROFILE_KEY = 'activeBackendProfileId';

function normalizeBackendUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Backend URL must use http:// or https://');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function readStoredProfiles(): BackendProfile[] {
  const raw = store.get(PROFILES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isBackendProfile);
}

function writeStoredProfiles(profiles: BackendProfile[]): void {
  store.set(
    PROFILES_KEY,
    profiles.filter(profile => profile.id !== LOCAL_BACKEND_PROFILE_ID)
  );
}

function isBackendProfile(value: unknown): value is BackendProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as BackendProfile;
  return (
    typeof profile.id === 'string' &&
    profile.id.length > 0 &&
    typeof profile.label === 'string' &&
    profile.label.trim().length > 0 &&
    (profile.mode === 'local' || profile.mode === 'remote') &&
    typeof profile.backendUrl === 'string' &&
    profile.backendUrl.trim().length > 0
  );
}

export function createLocalProfile(): BackendProfile {
  return {
    id: LOCAL_BACKEND_PROFILE_ID,
    label: 'Local',
    mode: 'local',
    backendUrl: ''
  };
}

export function listBackendProfiles(): BackendProfile[] {
  return [createLocalProfile(), ...readStoredProfiles()];
}

export function getBackendProfile(id: string): BackendProfile | null {
  return listBackendProfiles().find(profile => profile.id === id) ?? null;
}

export function getActiveBackendProfileId(): string {
  const stored = store.get(ACTIVE_PROFILE_KEY, LOCAL_BACKEND_PROFILE_ID);
  return typeof stored === 'string' && stored.trim().length > 0 ? stored : LOCAL_BACKEND_PROFILE_ID;
}

export function setActiveBackendProfileId(id: string): void {
  if (!getBackendProfile(id)) {
    throw new Error(`Unknown backend profile: ${id}`);
  }
  store.set(ACTIVE_PROFILE_KEY, id);
}

export function addBackendProfile({
  label,
  backendUrl
}: {
  label: string;
  backendUrl: string;
}): BackendProfile {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    throw new Error('Backend label is required.');
  }
  const normalizedUrl = normalizeBackendUrl(backendUrl);
  if (!normalizedUrl) {
    throw new Error('Backend URL is required.');
  }

  const profile: BackendProfile = {
    id: randomUUID(),
    label: trimmedLabel,
    mode: 'remote',
    backendUrl: normalizedUrl
  };
  writeStoredProfiles([...readStoredProfiles(), profile]);
  return profile;
}

export function removeBackendProfile(id: string): void {
  if (id === LOCAL_BACKEND_PROFILE_ID) {
    throw new Error('The local backend profile cannot be removed.');
  }
  writeStoredProfiles(readStoredProfiles().filter(profile => profile.id !== id));
  if (getActiveBackendProfileId() === id) {
    store.set(ACTIVE_PROFILE_KEY, LOCAL_BACKEND_PROFILE_ID);
  }
}

export function sessionPartitionForProfile(id: string): string {
  return `persist:backend-${id}`;
}

export function resolveActiveBackend({ shellOrigin }: { shellOrigin: string }): ActiveBackend {
  const profile = getBackendProfile(getActiveBackendProfileId()) ?? createLocalProfile();
  if (profile.mode === 'local') {
    return {
      id: profile.id,
      label: profile.label,
      mode: profile.mode,
      shellOrigin,
      apiBaseUrl: shellOrigin
    };
  }

  return {
    id: profile.id,
    label: profile.label,
    mode: profile.mode,
    shellOrigin,
    apiBaseUrl: profile.backendUrl
  };
}

export function toPublicProfile(
  profile: BackendProfile,
  { shellOrigin }: { shellOrigin: string }
): Omit<ActiveBackend, 'shellOrigin'> & { backendUrl: string } {
  if (profile.mode === 'local') {
    return {
      id: profile.id,
      label: profile.label,
      mode: profile.mode,
      backendUrl: shellOrigin,
      apiBaseUrl: shellOrigin
    };
  }

  return {
    id: profile.id,
    label: profile.label,
    mode: profile.mode,
    backendUrl: profile.backendUrl,
    apiBaseUrl: profile.backendUrl
  };
}
