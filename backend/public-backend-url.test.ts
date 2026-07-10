import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeOriginUrl,
  readConfiguredPublicBackendUrls,
  resolveAuthBaseUrl
} from './http/public-backend-url.ts';

describe('public backend URL resolution', () => {
  it('normalizes trailing slashes and missing schemes', () => {
    assert.equal(normalizeOriginUrl('https://backend.ovld.ai/'), 'https://backend.ovld.ai');
    assert.equal(normalizeOriginUrl('backend.ovld.ai'), 'http://backend.ovld.ai');
  });

  it('collects BETTER_AUTH_URL, BACKEND_URL, and OVERLORD_BACKEND_URL without duplicates', () => {
    const previous = {
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      BACKEND_URL: process.env.BACKEND_URL,
      OVERLORD_BACKEND_URL: process.env.OVERLORD_BACKEND_URL
    };

    process.env.BETTER_AUTH_URL = 'https://backend.ovld.ai/';
    process.env.BACKEND_URL = 'https://backend.ovld.ai';
    process.env.OVERLORD_BACKEND_URL = 'https://api.ovld.ai';

    try {
      assert.deepEqual(readConfiguredPublicBackendUrls(), [
        'https://backend.ovld.ai',
        'https://api.ovld.ai'
      ]);
      assert.equal(resolveAuthBaseUrl(), 'https://backend.ovld.ai');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
