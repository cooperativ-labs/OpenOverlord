import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAllowedBrowserOrigin, resolveAllowedBrowserOrigins } from './http/browser-origins.ts';

describe('resolveAllowedBrowserOrigins', () => {
  it('includes desktop loopback shell origins for cross-origin cloud auth', () => {
    const origins = resolveAllowedBrowserOrigins({
      baseUrl: 'https://overlord-backend-production.up.railway.app',
      devPort: '5173'
    });

    assert.ok(origins.includes('http://127.0.0.1:4310'));
    assert.ok(origins.includes('http://localhost:4310'));
    assert.ok(origins.includes('https://overlord-backend-production.up.railway.app'));
  });

  it('includes comma-separated hosted web origins from OVERLORD_WEB_ORIGINS', () => {
    const previous = process.env.OVERLORD_WEB_ORIGINS;
    process.env.OVERLORD_WEB_ORIGINS =
      'https://overlord-webapp.vercel.app, https://overlord-webapp-git-main-cooperativ-labs.vercel.app';

    try {
      const origins = resolveAllowedBrowserOrigins({
        baseUrl: 'https://overlord-backend-production.up.railway.app',
        devPort: '5173'
      });

      assert.ok(origins.includes('https://overlord-webapp.vercel.app'));
      assert.ok(origins.includes('https://overlord-webapp-git-main-cooperativ-labs.vercel.app'));
    } finally {
      if (previous === undefined) delete process.env.OVERLORD_WEB_ORIGINS;
      else process.env.OVERLORD_WEB_ORIGINS = previous;
    }
  });

  it('matches wildcard hosted web origins', () => {
    const origins = resolveAllowedBrowserOrigins({
      baseUrl: 'https://overlord-backend-production.up.railway.app',
      devPort: '5173'
    });
    origins.push('https://overlord-webapp-*.vercel.app');

    assert.ok(
      isAllowedBrowserOrigin('https://overlord-webapp-git-main-cooperativ-labs.vercel.app', origins)
    );
    assert.ok(!isAllowedBrowserOrigin('https://evil.vercel.app', origins));
  });
});
