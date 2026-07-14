import { randomBytes } from 'node:crypto';

const HANDOFF_TTL_MS = 60_000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type Handoff = { sessionToken: string; expiresAt: number };

const handoffs = new Map<string, Handoff>();

function discardExpiredHandoffs(now = Date.now()): void {
  for (const [ticket, handoff] of handoffs) {
    if (handoff.expiresAt <= now) handoffs.delete(ticket);
  }
}

/** Creates an opaque, one-time bridge from a browser session to Electron. */
export function createDesktopOAuthHandoff(sessionToken: string): string {
  discardExpiredHandoffs();
  const ticket = randomBytes(32).toString('base64url');
  handoffs.set(ticket, { sessionToken, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return ticket;
}

/** Consume a desktop OAuth handoff ticket exactly once. */
export function consumeDesktopOAuthHandoff(ticket: string): string | null {
  if (!TICKET_PATTERN.test(ticket)) return null;
  const handoff = handoffs.get(ticket);
  handoffs.delete(ticket);
  if (!handoff || handoff.expiresAt <= Date.now()) return null;
  return handoff.sessionToken;
}

export function desktopOAuthCallbackUrl(ticket: string): string {
  return `overlord://auth/callback?ticket=${encodeURIComponent(ticket)}`;
}
