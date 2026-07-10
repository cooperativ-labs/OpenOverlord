import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';

import type { Auth } from '../../auth/src/auth/config.ts';

import { resolveAuthBaseUrl } from './public-backend-url.ts';

type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

function parseGetSessionPayload(payload: unknown): AuthSession | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { session?: unknown; user?: unknown };
  if (!record.session || !record.user) return null;
  return record as AuthSession;
}

/**
 * Resolve a Better Auth browser session from an Express request.
 *
 * Cross-origin SPAs authenticate with `Authorization: Bearer <session>` on `/api/*`.
 * The bearer plugin only runs on the auth HTTP handler, so a direct
 * `auth.api.getSession()` call does not convert bearer tokens into the session
 * cookie that Better Auth expects. When cookie auth fails, mirror the
 * `/api/auth/get-session` request path so bearer clients authenticate the same way
 * the React auth client does.
 */
export async function resolveSessionFromBrowserRequest({
  auth,
  req
}: {
  auth: Auth;
  req: Request;
}): Promise<AuthSession | null> {
  const headers = fromNodeHeaders(req.headers);
  const cookieSession = await auth.api.getSession({ headers });
  if (cookieSession) return cookieSession;

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearerToken = authorization.slice('Bearer '.length).trim();
  if (!bearerToken || bearerToken.startsWith('out_')) return null;

  const response = await auth.handler(
    new Request(new URL('/api/auth/get-session', resolveAuthBaseUrl()), {
      method: 'GET',
      headers
    })
  );
  if (!response.ok) return null;
  return parseGetSessionPayload(await response.json());
}
