import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

export type AuthCredentialType = 'session_bearer' | 'user_token';

export type StoredAuthCredentials = {
  type: AuthCredentialType;
  token: string;
  backendUrl: string;
  updatedAt: string;
  /**
   * ISO timestamp when the stored token expires, when known. Minted user tokens
   * report their expiry (default 90 days); pasted `out_` tokens and env-var
   * tokens do not, so this stays `null`/absent. Persisting it gives `auth status`
   * a way to show remaining lifetime instead of just a logged-in boolean.
   */
  expiresAt?: string | null;
};

export function authCredentialsPath(): string {
  return path.join(resolveGlobalDataDir(), 'auth.json');
}

export function readStoredAuthCredentials(): StoredAuthCredentials | null {
  const filePath = authCredentialsPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as StoredAuthCredentials;
    if (typeof raw.token !== 'string' || !raw.token.trim()) return null;
    if (raw.type !== 'session_bearer' && raw.type !== 'user_token') return null;
    if (typeof raw.backendUrl !== 'string' || !raw.backendUrl.trim()) return null;
    // `expiresAt` is optional and best-effort; drop a malformed value rather than
    // rejecting the whole credential, which would needlessly log the user out.
    if (
      raw.expiresAt !== undefined &&
      raw.expiresAt !== null &&
      typeof raw.expiresAt !== 'string'
    ) {
      raw.expiresAt = null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeStoredAuthCredentials({
  type,
  token,
  backendUrl,
  expiresAt = null
}: {
  type: AuthCredentialType;
  token: string;
  backendUrl: string;
  expiresAt?: string | null;
}): void {
  const filePath = authCredentialsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: StoredAuthCredentials = {
    type,
    token,
    backendUrl: backendUrl.replace(/\/+$/, ''),
    updatedAt: new Date().toISOString(),
    expiresAt: expiresAt ?? null
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that restrict chmod.
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function clearStoredAuthCredentials(): void {
  const filePath = authCredentialsPath();
  if (!existsSync(filePath)) return;
  unlinkSync(filePath);
}

export function resolveAuthBearerToken({
  backendUrl,
  env = process.env
}: {
  backendUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const fromEnv =
    env.OVERLORD_USER_TOKEN?.trim() || env.OVLD_USER_TOKEN?.trim() || env.USER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const stored = readStoredAuthCredentials();
  if (!stored) return undefined;
  if (backendUrl && normalizeBaseUrl(stored.backendUrl) !== normalizeBaseUrl(backendUrl)) {
    return undefined;
  }
  return stored.token;
}
