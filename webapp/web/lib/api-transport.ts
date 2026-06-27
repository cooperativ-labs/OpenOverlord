import { apiFetchCredentials, getAuthorizationHeader, resolveApiUrl } from './api-base.ts';

export async function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const authHeader = getAuthorizationHeader();
  if (authHeader) {
    for (const [key, value] of Object.entries(authHeader)) {
      headers.set(key, value);
    }
  }

  return fetch(resolveApiUrl(path), {
    ...init,
    credentials: init.credentials ?? apiFetchCredentials(),
    headers
  });
}

export function resolveEventSourceUrl(path: string): string {
  return resolveApiUrl(path);
}
