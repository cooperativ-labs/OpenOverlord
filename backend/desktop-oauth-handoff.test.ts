import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginDesktopGitHubOAuth,
  browserOAuthCallbackUrl,
  consumeBrowserOAuthHandoff,
  consumeDesktopOAuthHandoff,
  createBrowserOAuthHandoff,
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

test('browser OAuth handoffs are opaque, single-use, and audience-bound', () => {
  const ticket = createBrowserOAuthHandoff('session-token');
  const callback = new URL(browserOAuthCallbackUrl('https://app.ovld.ai', ticket));

  assert.equal(callback.origin, 'https://app.ovld.ai');
  assert.equal(callback.searchParams.get('overlord_oauth_ticket'), ticket);
  assert.equal(callback.toString().includes('session-token'), false);
  assert.equal(
    consumeDesktopOAuthHandoff(ticket),
    null,
    'browser tickets cannot be exchanged by desktop'
  );

  const consumableTicket = createBrowserOAuthHandoff('session-token');
  assert.equal(consumeBrowserOAuthHandoff(consumableTicket), 'session-token');
  assert.equal(consumeBrowserOAuthHandoff(consumableTicket), null);
});

test('desktop GitHub OAuth uses the fixed callback through Better Auth', async () => {
  let request: Request | undefined;
  const response = await beginDesktopGitHubOAuth(
    {
      async handler(input) {
        request = input;
        return Response.json({ url: 'https://github.com/login/oauth/authorize?state=opaque' });
      }
    },
    'https://backend.ovld.ai'
  );

  assert.equal(request?.method, 'POST');
  assert.equal(request?.url, 'https://backend.ovld.ai/api/auth/sign-in/social');
  assert.deepEqual(await request?.json(), {
    provider: 'github',
    callbackURL: 'https://backend.ovld.ai/api/auth/desktop/callback'
  });
  assert.equal(response.ok, true);
});
