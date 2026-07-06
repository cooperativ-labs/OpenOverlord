import { PERMISSIONS } from '@overlord/auth';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import { ApiError } from './errors.ts';
import { requirePermission } from './rbac.ts';
import { createUserToken, revokeUserTokenSecret } from './repository.ts';

const CLIENT_ID_PREFIX = 'ovlc_';
const AUTH_CODE_PREFIX = 'ovla_';
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const USER_TOKEN_TTL_DAYS = 90;

export const OAUTH_SCOPES = [
  'overlord.workspace.read',
  'overlord.mission.read',
  'overlord.mission.write',
  'overlord.session.write'
] as const;

const SCOPE_SET = new Set<string>(OAUTH_SCOPES);

type RegisteredClient = {
  clientName: string;
  redirectUris: string[];
  issuedAt: number;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
  accessToken: string;
};

const authorizationCodes = new Map<string, AuthorizationCode>();

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function oauthSigningSecret(): string {
  return (
    process.env.OVERLORD_OAUTH_SIGNING_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    'overlord-local-oauth-development-secret'
  );
}

function signPayload(payload: string): string {
  return createHmac('sha256', oauthSigningSecret()).update(payload).digest('base64url');
}

function fixedTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function jsonError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function bodyString(req: Request, name: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function queryString(req: Request, name: string): string {
  const value = req.query[name];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

function requestParam(req: Request, name: string): string {
  return bodyString(req, name) || queryString(req, name);
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function encodeClient(client: RegisteredClient): string {
  const payload = base64Url(JSON.stringify(client));
  return `${CLIENT_ID_PREFIX}${payload}.${signPayload(payload)}`;
}

function decodeClient(clientId: string): RegisteredClient | null {
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const encoded = clientId.slice(CLIENT_ID_PREFIX.length);
  const dot = encoded.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = encoded.slice(0, dot);
  const signature = encoded.slice(dot + 1);
  if (!fixedTimeEqual(signPayload(payload), signature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;
    const candidate = decoded as Partial<RegisteredClient>;
    if (!Array.isArray(candidate.redirectUris)) return null;
    const redirectUris = candidate.redirectUris.filter(
      uri => typeof uri === 'string' && isAllowedRedirectUri(uri)
    );
    if (redirectUris.length === 0) return null;
    return {
      clientName:
        typeof candidate.clientName === 'string' && candidate.clientName.trim()
          ? candidate.clientName.trim().slice(0, 120)
          : 'MCP client',
      redirectUris,
      issuedAt: typeof candidate.issuedAt === 'number' ? candidate.issuedAt : 0
    };
  } catch {
    return null;
  }
}

function requestedScopes(rawScope: string): string {
  const scopes = (rawScope || OAUTH_SCOPES.join(' '))
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);
  const unknown = scopes.find(scope => !SCOPE_SET.has(scope));
  if (unknown) {
    throw new ApiError(400, `Unsupported OAuth scope: ${unknown}`, undefined, 'invalid_scope');
  }
  return Array.from(new Set(scopes)).join(' ');
}

function validateAuthorizationRequest(req: Request): {
  client: RegisteredClient;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
} {
  const responseType = requestParam(req, 'response_type');
  if (responseType !== 'code') {
    throw new ApiError(
      400,
      'OAuth response_type must be code',
      undefined,
      'unsupported_response_type'
    );
  }

  const clientId = requestParam(req, 'client_id');
  const client = decodeClient(clientId);
  if (!client)
    throw new ApiError(400, 'Unknown or invalid OAuth client', undefined, 'invalid_client');

  const redirectUri = requestParam(req, 'redirect_uri');
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw new ApiError(
      400,
      'redirect_uri is not registered for this client',
      undefined,
      'invalid_request'
    );
  }

  const codeChallengeMethod = requestParam(req, 'code_challenge_method');
  const codeChallenge = requestParam(req, 'code_challenge');
  if (codeChallengeMethod !== 'S256' || !codeChallenge) {
    throw new ApiError(400, 'OAuth PKCE with S256 is required', undefined, 'invalid_request');
  }

  return {
    client,
    clientId,
    redirectUri,
    scope: requestedScopes(requestParam(req, 'scope')),
    state: requestParam(req, 'state'),
    codeChallenge
  };
}

function appendParams(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function consumeAuthorizationCode(code: string): AuthorizationCode | null {
  const entry = authorizationCodes.get(code);
  authorizationCodes.delete(code);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

export function webPublicBaseUrl(req: Request): string {
  const configured =
    process.env.OVERLORD_WEBAPP_PUBLIC_URL?.trim() || process.env.OVERLORD_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

export function oauthProtectedResourceMetadata(req: Request): Record<string, unknown> {
  const baseUrl = webPublicBaseUrl(req);
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [`${baseUrl}/.well-known/oauth-authorization-server`],
    bearer_methods_supported: ['header'],
    resource_documentation: `${baseUrl}/mcp`,
    scopes_supported: OAUTH_SCOPES
  };
}

export function oauthAuthorizationServerMetadata(req: Request): Record<string, unknown> {
  const baseUrl = webPublicBaseUrl(req);
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/approve`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: OAUTH_SCOPES
  };
}

export function redirectToOAuthApproval(req: Request, res: Response): void {
  const baseUrl = webPublicBaseUrl(req);
  const destination = new URL('/oauth/approve', baseUrl);
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      for (const item of value) destination.searchParams.append(key, String(item));
    } else if (value !== undefined) {
      destination.searchParams.set(key, String(value));
    }
  }
  res.redirect(destination.toString());
}

export function handleOAuthRegister(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter(uri => typeof uri === 'string' && isAllowedRedirectUri(uri))
    : [];
  if (redirectUris.length === 0) {
    jsonError(res, 400, 'invalid_redirect_uri', 'At least one HTTPS redirect_uri is required.');
    return;
  }

  const client: RegisteredClient = {
    clientName:
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 120)
        : 'MCP client',
    redirectUris,
    issuedAt: Math.floor(Date.now() / 1000)
  };
  const clientId = encodeClient(client);

  res.status(201).json({
    client_id: clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: client.issuedAt
  });
}

export function handleOAuthRequestInfo(req: Request, res: Response): void {
  const parsed = validateAuthorizationRequest(req);
  res.json({
    clientName: parsed.client.clientName,
    redirectUri: parsed.redirectUri,
    redirectHost: new URL(parsed.redirectUri).host,
    scopes: parsed.scope.split(/\s+/),
    state: parsed.state
  });
}

export async function handleOAuthApprove(req: Request, res: Response): Promise<void> {
  await requirePermission(PERMISSIONS.USER_TOKEN_SELF_CREATE);
  const parsed = validateAuthorizationRequest(req);
  const decision = bodyString(req, 'decision');

  if (decision === 'deny') {
    res.json({
      redirectTo: appendParams(parsed.redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied the Overlord MCP connection.',
        state: parsed.state
      })
    });
    return;
  }

  if (decision !== 'approve') {
    throw new ApiError(400, 'OAuth decision must be approve or deny', undefined, 'invalid_request');
  }

  const result = await createUserToken({
    label: `OAuth MCP: ${parsed.client.clientName}`,
    scope: 'mission_lifecycle',
    expiresAt: new Date(Date.now() + USER_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  });
  const code = `${AUTH_CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
  authorizationCodes.set(code, {
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    codeChallenge: parsed.codeChallenge,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    accessToken: result.secret
  });

  res.json({
    redirectTo: appendParams(parsed.redirectUri, {
      code,
      state: parsed.state
    })
  });
}

export function handleOAuthToken(req: Request, res: Response): void {
  const grantType = bodyString(req, 'grant_type');
  if (grantType !== 'authorization_code') {
    jsonError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    return;
  }

  const code = bodyString(req, 'code');
  const clientId = bodyString(req, 'client_id');
  const redirectUri = bodyString(req, 'redirect_uri');
  const codeVerifier = bodyString(req, 'code_verifier');
  const entry = consumeAuthorizationCode(code);
  if (!entry) {
    jsonError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
    return;
  }
  if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
    jsonError(res, 400, 'invalid_grant', 'Authorization code request does not match.');
    return;
  }

  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  if (!codeVerifier || challenge !== entry.codeChallenge) {
    jsonError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    return;
  }

  res.json({
    access_token: entry.accessToken,
    token_type: 'Bearer',
    expires_in: USER_TOKEN_TTL_DAYS * 24 * 60 * 60,
    scope: entry.scope
  });
}

export async function handleOAuthRevoke(req: Request, res: Response): Promise<void> {
  const token = bodyString(req, 'token');
  if (token) await revokeUserTokenSecret(token);
  res.status(200).json({ ok: true });
}
