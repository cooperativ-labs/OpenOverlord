import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth'
});

export function normalizeLocalUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function usernameToLocalEmail(username: string): string {
  return `${normalizeLocalUsername(username)}@overlord.local`;
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
