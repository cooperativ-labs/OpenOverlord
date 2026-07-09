import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveServeSpa } from './http/serve-spa.ts';

describe('resolveServeSpa', () => {
  it('defaults to serving the SPA on the SQLite local edition', () => {
    assert.equal(resolveServeSpa({ dialect: 'sqlite', env: {} }), true);
  });

  it('defaults to API-only on the Postgres cloud control plane', () => {
    assert.equal(resolveServeSpa({ dialect: 'postgres', env: {} }), false);
  });

  it('honors OVERLORD_SERVE_SPA when set explicitly', () => {
    assert.equal(
      resolveServeSpa({ dialect: 'postgres', env: { OVERLORD_SERVE_SPA: 'true' } }),
      true
    );
    assert.equal(
      resolveServeSpa({ dialect: 'sqlite', env: { OVERLORD_SERVE_SPA: 'false' } }),
      false
    );
  });
});
