import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isOverlordStorageUrl, storageUrlNeedsAuthenticatedFetch } from './storage-url.ts';

describe('storage-url', () => {
  it('detects Overlord storage paths', () => {
    assert.equal(isOverlordStorageUrl('/api/storage/user-images/avatar.jpg'), true);
    assert.equal(isOverlordStorageUrl('https://cdn.example/avatar.jpg'), false);
  });

  it('requires authenticated fetch when the API base is cross-origin', () => {
    const url = '/api/storage/user-images/avatar.jpg';
    assert.equal(
      storageUrlNeedsAuthenticatedFetch({
        url,
        apiBaseUrl: 'https://overlord-backend.up.railway.app',
        pageOrigin: 'http://127.0.0.1:4310'
      }),
      true
    );
    assert.equal(
      storageUrlNeedsAuthenticatedFetch({
        url,
        apiBaseUrl: 'http://127.0.0.1:4310',
        pageOrigin: 'http://127.0.0.1:4310'
      }),
      false
    );
  });
});
