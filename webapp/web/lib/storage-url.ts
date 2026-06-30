import { getApiBaseUrl } from './api-base.ts';

/** Server-relative storage path served by `GET /api/storage/:bucket/:key`. */
export function isOverlordStorageUrl(url: string): boolean {
  return url.startsWith('/api/storage/');
}

/**
 * True when the SPA shell origin differs from the configured API base, so
 * `<img src>` / `<a href>` cannot reach stored bytes without an authenticated fetch.
 */
export function storageUrlNeedsAuthenticatedFetch({
  url,
  apiBaseUrl = getApiBaseUrl(),
  pageOrigin = typeof window !== 'undefined' ? window.location.origin : ''
}: {
  url: string;
  apiBaseUrl?: string;
  pageOrigin?: string;
}): boolean {
  if (!isOverlordStorageUrl(url)) return false;
  if (!apiBaseUrl || !pageOrigin) return false;
  try {
    return new URL(apiBaseUrl).origin !== pageOrigin;
  } catch {
    return false;
  }
}

/** Prefix server-relative storage URLs with the active API base when needed. */
export function resolveStorageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!isOverlordStorageUrl(url)) return url;
  const apiBaseUrl = getApiBaseUrl();
  if (!apiBaseUrl) return url;
  if (!storageUrlNeedsAuthenticatedFetch({ url, apiBaseUrl })) return url;
  return `${apiBaseUrl.replace(/\/+$/, '')}${url}`;
}
