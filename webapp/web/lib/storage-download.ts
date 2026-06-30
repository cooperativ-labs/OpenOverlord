import { fetchApi } from './api-transport.ts';
import { storageUrlNeedsAuthenticatedFetch } from './storage-url.ts';

/** Download a stored object, using an authenticated fetch when the shell is cross-origin. */
export async function downloadStorageObject({
  url,
  filename
}: {
  url: string;
  filename: string;
}): Promise<void> {
  if (!storageUrlNeedsAuthenticatedFetch({ url })) return;

  const response = await fetchApi(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
