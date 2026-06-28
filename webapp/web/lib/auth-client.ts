import { createAuthClient } from 'better-auth/react';

import {
  captureAuthTokenFromResponse,
  getAuthBaseUrl,
  getDesktopSessionToken,
  isRemoteBackend
} from './api-base.ts';

const remoteFetchOptions = isRemoteBackend()
  ? {
      auth: {
        type: 'Bearer' as const,
        token: () => getDesktopSessionToken()
      }
    }
  : {};

export const authClient = createAuthClient({
  baseURL: getAuthBaseUrl(),
  basePath: '/api/auth',
  fetchOptions: {
    credentials: isRemoteBackend() ? 'omit' : 'include',
    ...remoteFetchOptions,
    onSuccess(context) {
      captureAuthTokenFromResponse(context.response);
    },
    onResponse(context) {
      captureAuthTokenFromResponse(context.response);
    }
  }
});

export function normalizeLocalUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function usernameToLocalEmail(username: string): string {
  return `${normalizeLocalUsername(username)}@overlord.local`;
}

/** Recover the username (local-part) from a synthetic `<username>@overlord.local` email. */
export function localEmailToUsername(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

export function validateLocalUsername(username: string): string | null {
  const normalized = normalizeLocalUsername(username);
  if (normalized.length < 3) return 'Username must be at least 3 characters.';
  if (normalized.length > 40) return 'Username must be 40 characters or fewer.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    return 'Use letters, numbers, dots, underscores, or dashes.';
  }
  return null;
}
