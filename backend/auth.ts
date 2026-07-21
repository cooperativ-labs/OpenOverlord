import {
  authDatabaseFromAdapter,
  listActiveTokenScopeGrants,
  USER_TOKEN_PREFIX,
  verifyUserToken
} from '@overlord/auth';
import { resolveAdapter } from '@overlord/database';
import { toNodeHandler } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';

import { createAuth } from '../auth/src/auth/config.ts';

import { resolveSessionFromBrowserRequest } from './http/bearer-session.ts';
import { resolveAllowedBrowserOrigins } from './http/browser-origins.ts';
import { clientDeviceFromRequest } from './http/client-device.ts';
import { resolveAuthBaseUrl } from './http/public-backend-url.ts';
import { cascadeDeleteAccount } from './account-deletion.ts';
import {
  type ActiveWorkspace,
  authDomainDatabase,
  DATABASE_PATH,
  findActiveMembershipId,
  getActiveWorkspaceIdOrNull,
  loadWorkspaceRow,
  requireDatabaseClient,
  resolveActorForWorkspace,
  setActiveProfileId,
  setActiveTokenAuth,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  setClientDeviceIdentity,
  withRequestContextAsync
} from './db.ts';
import { emailOTPSenderFromEnv, verificationEmailSenderFromEnv } from './email-verification.ts';
import { ApiError } from './errors.ts';
import { grantWorkspaceAdminRole } from './workspaces.ts';

const authBaseUrl = resolveAuthBaseUrl();
process.env.BETTER_AUTH_URL ??= authBaseUrl;

export function getAllowedBrowserOrigins(): string[] {
  return resolveAllowedBrowserOrigins({
    baseUrl: resolveAuthBaseUrl(),
    devPort: process.env.OVERLORD_WEB_DEV_PORT
  });
}

export const auth = createAuth({
  database: authDatabaseFromAdapter(resolveAdapter({ databasePath: DATABASE_PATH })),
  baseURL: authBaseUrl,
  trustedOrigins: getAllowedBrowserOrigins(),
  onDeleteUser: cascadeDeleteAccount,
  sendVerificationEmail: verificationEmailSenderFromEnv(),
  sendEmailOTP: emailOTPSenderFromEnv()
});
export const authNodeHandler = toNodeHandler(auth);

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

function usesNonBrowserAuthSurface(req: Request): boolean {
  const path = req.path || req.url || req.originalUrl;
  return (
    path === '/protocol' ||
    path.startsWith('/protocol/') ||
    path === '/runner' ||
    path.startsWith('/runner/') ||
    path === '/mcp' ||
    path.startsWith('/mcp/')
  );
}

/** Whether the request originated from the loopback interface (the local host). */
function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.ip) || isLoopbackAddress(req.socket?.remoteAddress);
}

export interface WorkspaceMembership {
  workspaceUserId: string;
  workspace: ActiveWorkspace;
}

async function profileIdForWorkspaceUser(workspaceUserId: string): Promise<string | null> {
  const row = await requireDatabaseClient().get<{ profile_id: string }>(
    `SELECT profile_id FROM workspace_users
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
    [workspaceUserId]
  );
  return row?.profile_id ?? null;
}

async function resolveMembership(
  workspaceUserId: string,
  workspace: { id: string; slug: string; name: string; kind: string }
): Promise<WorkspaceMembership> {
  // Every active member keeps at least one role; this only ever creates a row
  // for a legacy/edge-case membership with none (see `grantWorkspaceAdminRole`),
  // it never re-grants ADMIN to a member who already has some role assigned.
  await grantWorkspaceAdminRole({ workspaceId: workspace.id, workspaceUserId });
  return {
    workspaceUserId,
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      kind: workspace.kind
    }
  };
}

/**
 * Resolve the logged-in profile's active workspace for this request. There is
 * no auto-join: a profile only ever resolves to workspaces it already has an
 * active `workspace_users` row in. Membership is created solely via an
 * explicit workspace creation or invitation-acceptance flow.
 *
 * This is a compatibility fallback for legacy unscoped handlers only; it is
 * never selected from request transport. Resource and workspace-scoped
 * handlers resolve their own membership. Returns `null` when the profile has
 * no active workspace membership at all.
 */
export async function ensureWorkspaceUser(
  profileId: string,
  explicitWorkspaceId?: string | null
): Promise<WorkspaceMembership | null> {
  // This optional internal argument is retained for resource-scoped callers and
  // conformance tests. Authentication never populates it from request headers
  // or cookies.
  if (explicitWorkspaceId) {
    const workspace = await loadWorkspaceRow(explicitWorkspaceId);
    if (workspace) {
      const membershipId = await findActiveMembershipId(explicitWorkspaceId, profileId);
      if (!membershipId) {
        throw new ApiError(403, 'Not an active member of the requested workspace');
      }
      return resolveMembership(membershipId, workspace);
    }
  }
  const defaultMembership = await requireDatabaseClient().get<{ id: string; workspace_id: string }>(
    `SELECT wu.id, wu.workspace_id FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id AND w.deleted_at IS NULL
      WHERE wu.profile_id = ? AND wu.status = 'active' AND wu.deleted_at IS NULL
      ORDER BY wu.created_at ASC LIMIT 1`,
    [profileId]
  );
  if (!defaultMembership) return null;

  const workspace = await loadWorkspaceRow(defaultMembership.workspace_id);
  if (!workspace) {
    throw new ApiError(500, 'Workspace membership references a missing workspace');
  }
  return resolveMembership(defaultMembership.id, workspace);
}

export async function requireAuthenticatedSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  return withRequestContextAsync(async () => {
    setClientDeviceIdentity(clientDeviceFromRequest(req));
    try {
      const nonBrowser = usesNonBrowserAuthSurface(req);

      // 1. Browser / SPA session auth (Better Auth cookies or bearer session
      //    tokens). Desktop remote and hosted web send `Authorization: Bearer
      //    <session>` for every `/api/*` call — including `/api/runner/status`
      //    from the sidebar. Skipping session resolution on the CLI
      //    protocol/runner path prefixes would reject those clients with
      //    "Authentication required" even when logged in; USER_TOKEN bearers
      //    (`out_…`) still return null from session resolution and fall through
      //    to step 2. Loopback trust remains gated on `nonBrowser` below.
      const session = await resolveSessionFromBrowserRequest({ auth, req });
      if (session) {
        setActiveProfileId(session.user.id);
        // `null` means the profile has no active workspace membership at all
        // (e.g. a brand-new signup with no invite). The request proceeds
        // authenticated but with no active workspace; RBAC gates below
        // (`requirePermission`/`actorCan`) reject it uniformly since they
        // treat a null actor as having no roles.
        const membership = await ensureWorkspaceUser(session.user.id);
        setActiveWorkspaceContext(membership?.workspace ?? null);
        setActiveWorkspaceUser(membership?.workspaceUserId ?? null);
        next();
        return;
      }

      // 2. USER_TOKEN bearer auth (any surface). Tokens authenticate the owning
      //    profile, not a workspace. The request's active workspace preference
      //    is then validated against that profile's memberships, and RBAC for
      //    the resolved workspace supplies the authorization boundary. A
      //    zero-membership profile (headless post-signup, pre-onboarding) is
      //    not rejected here — it proceeds with no active workspace so it can
      //    reach `/api/onboarding`; workspace-scoped routes reject it via RBAC
      //    (a null actor has no roles) or their own explicit checks.
      const bearerToken = extractBearerToken(req);
      if (bearerToken?.startsWith(USER_TOKEN_PREFIX)) {
        const verified = await verifyUserToken(authDomainDatabase(), bearerToken);
        if (!verified) {
          res.status(401).json({ error: 'Invalid or expired USER_TOKEN' });
          return;
        }
        setActiveProfileId(verified.profileId);
        // `membership.workspace` is already backed by a live workspace row —
        // `ensureWorkspaceUser` resolved it moments ago — so it is used directly.
        const membership = await ensureWorkspaceUser(verified.profileId);
        const scopeGrants = await listActiveTokenScopeGrants(authDomainDatabase(), verified.id);
        setActiveWorkspaceContext(membership?.workspace ?? null);
        setActiveTokenAuth({
          workspaceUserId: membership?.workspaceUserId ?? null,
          tokenId: verified.id,
          scopeGrants
        });
        next();
        return;
      }

      // 3. Loopback-trusted local operator for the CLI protocol/runner surface,
      //    which historically ran unauthenticated on localhost. This resolves only
      //    to an existing workspace user in the process-wide default workspace
      //    (self-hosted single-operator parity); on a fresh database, account
      //    creation must happen first so RBAC has a real actor to evaluate.
      //    Browser `/api` routes deliberately do NOT get this fallback,
      //    preserving web login. A zero-workspace boot (no organization/
      //    workspace created yet) has no default workspace to resolve against;
      //    proceed unauthenticated-actor rather than throwing, mirroring the
      //    zero-membership USER_TOKEN branch above.
      if (nonBrowser && isLoopbackRequest(req)) {
        const defaultWorkspaceId = getActiveWorkspaceIdOrNull();
        const workspaceUserId = defaultWorkspaceId
          ? await resolveActorForWorkspace(defaultWorkspaceId)
          : null;
        setActiveProfileId(
          workspaceUserId ? await profileIdForWorkspaceUser(workspaceUserId) : null
        );
        setActiveWorkspaceUser(workspaceUserId);
        next();
        return;
      }

      if ((req.path || req.url || req.originalUrl).startsWith('/mcp')) {
        res.setHeader(
          'WWW-Authenticate',
          'Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp"'
        );
      }
      res.status(401).json({ error: 'Authentication required' });
    } catch (err) {
      next(err);
    }
  });
}
