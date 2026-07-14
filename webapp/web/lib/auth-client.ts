import { emailOTPClient } from 'better-auth/client/plugins';
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

/**
 * OAuth initiation must retain Better Auth's short-lived state cookie. Remote
 * API calls normally omit cookies in favour of bearer sessions, but doing that
 * for the social sign-in request means the browser cannot return the state
 * cookie when the provider redirects to the callback.
 */
export function socialSignInFetchOptions(): { credentials: RequestCredentials } {
  return { credentials: 'include' };
}

export const authClient = createAuthClient({
  baseURL: getAuthBaseUrl(),
  basePath: '/api/auth',
  // Enables `authClient.emailOtp.*` (e.g. verifyEmail) for the typed 6-digit
  // code flow; pairs with the `emailOTP` server plugin in auth/src/auth/config.ts.
  plugins: [emailOTPClient()],
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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return 'Enter a valid email address.';
  }
  return null;
}
