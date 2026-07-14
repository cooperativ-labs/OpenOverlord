import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { socialSignInFetchOptions } from './auth-client.ts';

describe('socialSignInFetchOptions', () => {
  it('keeps Better Auth state cookies during an OAuth bootstrap request', () => {
    assert.deepEqual(socialSignInFetchOptions(), { credentials: 'include' });
  });
});
