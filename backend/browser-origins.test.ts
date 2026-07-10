import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAllowedBrowserOrigin, resolveAllowedBrowserOrigins } from './http/browser-origins.ts';

describe('resolveAllowedBrowserOrigins', () => {
  it('includes desktop loopback shell origins for cross-origin cloud auth', () => {
    const origins = resolveAllowedBrowserOrigins({
      baseUrl: 'https://backend.ovld.ai',
      devPort: '5173'
    });

    assert.ok(origins.includes('http://127.0.0.1:4310'));
    assert.ok(origins.includes('http://localhost:4310'));
    assert.ok(origins.includes('https://backend.ovld.ai'));
  });

  it('includes comma-separated hosted web origins from OVERLORD_WEB_ORIGINS', () => {
    const previous = process.env.OVERLORD_WEB_ORIGINS;
    process.env.OVERLORD_WEB_ORIGINS =
      'https://overlord-webapp.vercel.app, https://overlord-webapp-git-main-cooperativ-labs.vercel.app';

    try {
      const origins = resolveAllowedBrowserOrigins({
        baseUrl: 'https://backend.ovld.ai',
        devPort: '5173'
      });

      assert.ok(origins.includes('https://overlord-webapp.vercel.app'));
      assert.ok(origins.includes('https://overlord-webapp-git-main-cooperativ-labs.vercel.app'));
    } finally {
      if (previous === undefined) delete process.env.OVERLORD_WEB_ORIGINS;
      else process.env.OVERLORD_WEB_ORIGINS = previous;
    }
  });

  it('includes configured public backend URLs from env', () => {
    const previous = {
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      BACKEND_URL: process.env.BACKEND_URL
    };
    process.env.BETTER_AUTH_URL = 'https://backend.ovld.ai';
    process.env.BACKEND_URL = 'https://api.ovld.ai';

    try {
      const origins = resolveAllowedBrowserOrigins({
        baseUrl: 'http://127.0.0.1:4310',
        devPort: '5173'
      });

      assert.ok(origins.includes('https://backend.ovld.ai'));
      assert.ok(origins.includes('https://api.ovld.ai'));
    } finally {
      if (previous.BETTER_AUTH_URL === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = previous.BETTER_AUTH_URL;
      if (previous.BACKEND_URL === undefined) delete process.env.BACKEND_URL;
      else process.env.BACKEND_URL = previous.BACKEND_URL;
    }
  });

  it('matches wildcard hosted web origins', () => {
    const origins = resolveAllowedBrowserOrigins({
      baseUrl: 'https://backend.ovld.ai',
      devPort: '5173'
    });
    origins.push('https://overlord-webapp-*.vercel.app');

    assert.ok(
      isAllowedBrowserOrigin('https://overlord-webapp-git-main-cooperativ-labs.vercel.app', origins)
    );
    assert.ok(!isAllowedBrowserOrigin('https://evil.vercel.app', origins));
  });
});
