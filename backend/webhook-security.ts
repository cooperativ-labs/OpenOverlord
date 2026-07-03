import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';

import { DATABASE_DIALECT } from './db.ts';
import { ApiError } from './errors.ts';

/**
 * Stripe-style signature header value: `t=<unix-seconds>,v1=<hex hmac-sha256>`.
 * The timestamp lets consumers bound replay (reject `|now - t| > 5 min`); the
 * delivery id (a separate header) makes retries idempotent.
 */
export function signWebhookPayload(
  secret: string,
  rawBody: string
): { header: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { header: `t=${timestamp},v1=${signature}`, timestamp };
}

/**
 * Parses the operator-declared internal-host allowlist. A comma-separated list
 * of exact hostnames or `*.suffix` glob patterns (e.g. `*.railway.internal`) —
 * see planning/feature-plans/mission-data-webhooks-api.md §3.2. Kept as an env
 * var rather than a workspace setting: which services share a private network
 * is deployment topology, an operator fact, not something a compromised admin
 * account should be able to re-label.
 */
function internalHostPatterns(): string[] {
  return (process.env.OVERLORD_WEBHOOK_INTERNAL_HOSTS ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

const LOCAL_EDITION_IMPLICIT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether `hostname` is a colocated/trusted endpoint: exempt from the SSRF
 * private-network block and the https requirement, and pre-selected as the
 * `full` payload mode in the management UI. Local edition (SQLite) implicitly
 * trusts loopback since the backend already runs on the user's own machine.
 */
export function isInternalWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (DATABASE_DIALECT === 'sqlite' && LOCAL_EDITION_IMPLICIT_HOSTS.has(host)) {
    return true;
  }
  for (const pattern of internalHostPatterns()) {
    if (pattern.startsWith('*.')) {
      if (host.endsWith(pattern.slice(1))) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Parse and validate an endpoint URL at save time. Throws `ApiError(400)` on
 * an unparseable URL or a non-internal host using plain `http://`.
 */
export function parseWebhookEndpointUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Endpoint URL is not a valid URL');
  }
  const isInternal = isInternalWebhookHost(url.hostname);
  if (url.protocol !== 'https:' && !(isInternal && url.protocol === 'http:')) {
    throw new ApiError(
      400,
      'Endpoint URL must use https:// (internal hosts matching OVERLORD_WEBHOOK_INTERNAL_HOSTS may use http://)'
    );
  }
  return url;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || (a === 169 && b === 254)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
  );
}

/**
 * Re-validated at dispatch time (in addition to save time): resolve the
 * endpoint hostname and reject loopback/RFC-1918/link-local/private-IPv6
 * targets unless the host is declared internal. A blanket private-IP block
 * would otherwise reject exactly the colocated consumers internal hosts are
 * meant to support (e.g. Railway's private mesh resolves to private IPv6).
 *
 * Known limitation: this checks the address immediately before connecting,
 * not the address the HTTP client actually opens a socket to, so a
 * fast DNS-rebind between check and connect is a residual risk; closing it
 * fully would require pinning the fetch to the resolved IP via a custom
 * dispatcher/agent, deferred as a follow-up.
 */
export async function assertPublicWebhookTarget(url: URL): Promise<void> {
  if (isInternalWebhookHost(url.hostname)) return;

  const hostname = url.hostname;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 && isPrivateIPv4(hostname)) {
    throw new ApiError(400, `Endpoint resolves to a private address (${hostname})`);
  }
  if (literalFamily === 6 && isPrivateIPv6(hostname)) {
    throw new ApiError(400, `Endpoint resolves to a private address (${hostname})`);
  }
  if (literalFamily) return;

  const records = await dns.lookup(hostname, { all: true });
  for (const record of records) {
    if (record.family === 4 && isPrivateIPv4(record.address)) {
      throw new ApiError(
        400,
        `Endpoint hostname resolves to a private address (${record.address})`
      );
    }
    if (record.family === 6 && isPrivateIPv6(record.address)) {
      throw new ApiError(
        400,
        `Endpoint hostname resolves to a private address (${record.address})`
      );
    }
  }
}

/** Best-effort scrub of common secret-shaped tokens from externally-sourced text before persistence (e.g. a webhook response body echoing an Authorization header back). */
export function redactSecretLikeTokens(text: string): string {
  return text
    .replace(/\b(whsec|out|sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      '[redacted-jwt]'
    );
}
