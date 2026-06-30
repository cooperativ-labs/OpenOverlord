import { useEffect, useState } from 'react';

import { fetchApi } from './api-transport.ts';
import { isOverlordStorageUrl, storageUrlNeedsAuthenticatedFetch } from './storage-url.ts';

/**
 * Resolves a profile/attachment/storage URL for rendering. Overlord storage paths
 * stay relative when the shell shares an origin (or dev proxy) with the API; in
 * desktop remote mode they are fetched with bearer auth and exposed as blob URLs.
 */
export function useAuthenticatedMediaUrl(url: string | null | undefined): string | null {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(() => {
    if (!url) return null;
    if (!isOverlordStorageUrl(url) || !storageUrlNeedsAuthenticatedFetch({ url })) return url;
    return null;
  });

  useEffect(() => {
    if (!url) {
      setResolvedUrl(null);
      return;
    }

    if (!isOverlordStorageUrl(url) || !storageUrlNeedsAuthenticatedFetch({ url })) {
      setResolvedUrl(url);
      return;
    }

    setResolvedUrl(null);
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const response = await fetchApi(url);
        if (!response.ok || cancelled) return;
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedUrl(objectUrl);
      } catch {
        if (!cancelled) setResolvedUrl(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return resolvedUrl;
}
