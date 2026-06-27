import { apiFetchCredentials, getBearerAuthorizationHeader, resolveApiUrl } from './api-base.ts';

export async function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const bearer = getBearerAuthorizationHeader();
  if (bearer) {
    for (const [key, value] of Object.entries(bearer)) {
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
