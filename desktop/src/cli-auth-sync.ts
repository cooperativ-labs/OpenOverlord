import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_BACKEND_PROFILE_ID } from './backend-profiles.js';
import { getSessionToken, setSessionToken } from './backend-token-store.js';

type CliAuthCredentialType = 'session_bearer' | 'user_token';

type CliStoredAuthCredentials = {
  type: CliAuthCredentialType;
  token: string;
  backendUrl: string;
  updatedAt: string;
};

function resolveGlobalDataDir(): string {
  return process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld');
}

function authCredentialsPath(): string {
  return path.join(resolveGlobalDataDir(), 'auth.json');
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function readCliAuthCredentials(): CliStoredAuthCredentials | null {
  const filePath = authCredentialsPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as CliStoredAuthCredentials;
    if (typeof raw.token !== 'string' || !raw.token.trim()) return null;
    if (raw.type !== 'session_bearer' && raw.type !== 'user_token') return null;
    if (typeof raw.backendUrl !== 'string' || !raw.backendUrl.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCliAuthCredentials({
  type,
  token,
  backendUrl
}: {
  type: CliAuthCredentialType;
  token: string;
  backendUrl: string;
}): void {
  const filePath = authCredentialsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: CliStoredAuthCredentials = {
    type,
    token,
    backendUrl: normalizeBaseUrl(backendUrl),
    updatedAt: new Date().toISOString()
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that restrict chmod.
  }
}

function clearCliAuthCredentialsIfMatching(backendUrl: string): void {
  const stored = readCliAuthCredentials();
  if (!stored) return;
  if (normalizeBaseUrl(stored.backendUrl) !== normalizeBaseUrl(backendUrl)) return;
  const filePath = authCredentialsPath();
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** Mirror a local desktop session bearer into `~/.ovld/auth.json` for the CLI. */
export function syncSessionTokenToCliAuth({
  profileId,
  token,
  backendUrl
}: {
  profileId: string;
  token: string;
  backendUrl: string;
}): void {
  if (profileId !== LOCAL_BACKEND_PROFILE_ID) return;
  const trimmed = token.trim();
  if (!trimmed) {
    clearCliAuthCredentialsIfMatching(backendUrl);
    return;
  }
  writeCliAuthCredentials({ type: 'session_bearer', token: trimmed, backendUrl });
}

/** Import a CLI session bearer when the desktop local profile has no stored token. */
export function hydrateLocalDesktopSessionFromCliAuth({
  backendUrl
}: {
  backendUrl: string;
}): void {
  const existing = getSessionToken(LOCAL_BACKEND_PROFILE_ID);
  if (existing) return;
  const imported = readCliSessionTokenForLocalBackend(backendUrl);
  if (!imported) return;
  setSessionToken({ profileId: LOCAL_BACKEND_PROFILE_ID, token: imported });
}

export function readCliSessionTokenForLocalBackend(backendUrl: string): string | null {
  const stored = readCliAuthCredentials();
  if (!stored || stored.type !== 'session_bearer') return null;
  if (normalizeBaseUrl(stored.backendUrl) !== normalizeBaseUrl(backendUrl)) return null;
  return stored.token.trim() || null;
}
