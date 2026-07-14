import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDesktopOAuthHandoffUrl } from './oauth-handoff.ts';

const TICKET = 'a'.repeat(43);

test('accepts only the desktop OAuth callback URL with an opaque ticket', () => {
  assert.equal(parseDesktopOAuthHandoffUrl(`overlord://auth/callback?ticket=${TICKET}`), TICKET);
});

test('rejects arbitrary deep links and credential-shaped callback values', () => {
  assert.equal(parseDesktopOAuthHandoffUrl(`overlord://auth/other?ticket=${TICKET}`), null);
  assert.equal(parseDesktopOAuthHandoffUrl(`overlord://other/callback?ticket=${TICKET}`), null);
  assert.equal(parseDesktopOAuthHandoffUrl('overlord://auth/callback?ticket=session-token'), null);
  assert.equal(parseDesktopOAuthHandoffUrl(`https://auth/callback?ticket=${TICKET}`), null);
});
