import { randomBytes } from 'node:crypto';

const HANDOFF_TTL_MS = 60_000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type Handoff = { audience: 'browser' | 'desktop'; sessionToken: string; expiresAt: number };

/** The small Auth Layer surface needed to start a browser-owned OAuth flow. */
export interface DesktopOAuthAuthHandler {
  handler(request: Request): Promise<Response>;
}

const handoffs = new Map<string, Handoff>();

function discardExpiredHandoffs(now = Date.now()): void {
  for (const [ticket, handoff] of handoffs) {
    if (handoff.expiresAt <= now) handoffs.delete(ticket);
  }
}

/** Creates an opaque, one-time bridge from a browser session to Electron. */
function createOAuthHandoff(sessionToken: string, audience: Handoff['audience']): string {
  discardExpiredHandoffs();
  const ticket = randomBytes(32).toString('base64url');
  handoffs.set(ticket, { audience, sessionToken, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return ticket;
}

function consumeOAuthHandoff(ticket: string, audience: Handoff['audience']): string | null {
  if (!TICKET_PATTERN.test(ticket)) return null;
  const handoff = handoffs.get(ticket);
  handoffs.delete(ticket);
  if (!handoff || handoff.audience !== audience || handoff.expiresAt <= Date.now()) return null;
  return handoff.sessionToken;
}

/** Creates an opaque, one-time bridge from a browser session to Electron. */
export function createDesktopOAuthHandoff(sessionToken: string): string {
  return createOAuthHandoff(sessionToken, 'desktop');
}

/** Consume a desktop OAuth handoff ticket exactly once. */
export function consumeDesktopOAuthHandoff(ticket: string): string | null {
  return consumeOAuthHandoff(ticket, 'desktop');
}

/** Creates an opaque, one-time bridge from a browser session to the hosted web client. */
export function createBrowserOAuthHandoff(sessionToken: string): string {
  return createOAuthHandoff(sessionToken, 'browser');
}

/** Consume a hosted-web OAuth handoff ticket exactly once. */
export function consumeBrowserOAuthHandoff(ticket: string): string | null {
  return consumeOAuthHandoff(ticket, 'browser');
}

export function desktopOAuthCallbackUrl(ticket: string): string {
  return `overlord://auth/callback?ticket=${encodeURIComponent(ticket)}`;
}

/** Adds the opaque hosted-web handoff ticket to a pre-validated return origin. */
export function browserOAuthCallbackUrl(returnOrigin: string, ticket: string): string {
  const callback = new URL(returnOrigin);
  callback.searchParams.set('overlord_oauth_ticket', ticket);
  return callback.toString();
}

/**
 * Start GitHub OAuth through a first-party browser navigation. Calling the
 * Better Auth endpoint from Electron would put its state cookie in Electron's
 * cookie store, while GitHub returns to the system browser. Dispatching the
 * exact Better Auth request here lets the route forward that cookie and the
 * provider redirect to the browser that will receive the callback.
 */
export function beginDesktopGitHubOAuth(
  auth: DesktopOAuthAuthHandler,
  authBaseUrl: string
): Promise<Response> {
  return auth.handler(
    new Request(new URL('/api/auth/sign-in/social', authBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        callbackURL: new URL('/api/auth/desktop/callback', authBaseUrl).toString()
      })
    })
  );
}
