import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consumeDesktopOAuthHandoff,
  createDesktopOAuthHandoff,
  desktopOAuthCallbackUrl
} from './desktop-oauth-handoff.ts';

test('desktop OAuth handoffs are opaque and single-use', () => {
  const ticket = createDesktopOAuthHandoff('session-token');
  const callback = new URL(desktopOAuthCallbackUrl(ticket));

  assert.equal(callback.protocol, 'overlord:');
  assert.equal(callback.hostname, 'auth');
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('ticket'), ticket);
  assert.equal(callback.toString().includes('session-token'), false);
  assert.equal(consumeDesktopOAuthHandoff(ticket), 'session-token');
  assert.equal(consumeDesktopOAuthHandoff(ticket), null);
});

test('desktop OAuth handoff rejects malformed tickets', () => {
  assert.equal(consumeDesktopOAuthHandoff('not a ticket'), null);
});
