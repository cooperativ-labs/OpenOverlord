import {
  apiFetchCredentials,
  clearInMemoryAuthTokens,
  getActiveWorkspaceHeader,
  getAuthorizationHeader,
  resolveApiUrl
} from './api-base.ts';
import { remoteBackendDeviceHeaders } from './device-identity.ts';

function applyAuthorizationHeader(headers: Headers): boolean {
  const authHeader = getAuthorizationHeader();
  if (!authHeader) return false;
  for (const [key, value] of Object.entries(authHeader)) {
    headers.set(key, value);
  }
  return true;
}

function applyActiveWorkspaceHeader(headers: Headers): void {
  const activeWorkspaceHeader = getActiveWorkspaceHeader();
  if (!activeWorkspaceHeader) return;
  for (const [key, value] of Object.entries(activeWorkspaceHeader)) {
    headers.set(key, value);
  }
}

export async function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const sentAuthorization = applyAuthorizationHeader(headers);
  applyActiveWorkspaceHeader(headers);
  for (const [key, value] of Object.entries(await remoteBackendDeviceHeaders())) {
    headers.set(key, value);
  }

  const url = resolveApiUrl(path);
  const response = await fetch(url, {
    ...init,
    credentials: init.credentials ?? apiFetchCredentials(),
    headers
  });

  if (response.status !== 401 || !sentAuthorization) return response;

  clearInMemoryAuthTokens();
  const retryHeaders = new Headers(init.headers);
  return fetch(url, {
    ...init,
    credentials: 'include',
    headers: retryHeaders
  });
}

export function resolveEventSourceUrl(path: string): string {
  return resolveApiUrl(path);
}
