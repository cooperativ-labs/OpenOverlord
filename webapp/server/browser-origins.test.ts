import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAllowedBrowserOrigins } from './browser-origins.ts';

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
});
