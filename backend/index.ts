import './bootstrap-env.ts';

import { githubOAuthConfigFromEnv, type Permission, PERMISSIONS } from '@overlord/auth';
import { loadExternalAutomations } from '@overlord/automations';
import { fromNodeHeaders } from 'better-auth/node';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../cli/src/config.ts';
import { isExplicitRuntimeEnv, resolveLayeredEnv } from '../cli/src/env.ts';
import { handleMcpPost, mcpServerInfo } from '../mcp/server.ts';
import { ServiceError } from '../packages/core/service/errors.ts';
import type { LocalTargetBridgeCall } from '../packages/core/service/local-target/desktop-bridge.ts';
import type { StoredImageDto } from '../webapp/shared/contract.ts';

import { postMissionBranchObservations } from './branching/mission-branch-observations.ts';
import { postExecutionTargetObservations } from './branching/target-resource-observations.ts';
import { getExecutionTargetMigrationDiagnostics } from './execution/execution-target-migration.ts';
import {
  getAgentCatalog,
  getLaunchPreference,
  getLaunchSettings,
  getObjectivePrompt,
  launchObjective,
  refreshAgentCatalog,
  updateAgentCatalog,
  updateAgentLaunchConfig,
  updateLaunchPreference,
  updateTerminalProfile,
  updateWorktreeBranchAutomation
} from './execution/launch.ts';
import { resolveLocalTargetServerCapability } from './execution/local-target-capability.ts';
import { invokeLocalTargetOnServer } from './execution/local-target-invoke.ts';
import {
  getProjectExecutionTarget,
  getWorkspaceExecutionTargets,
  removeWorkspaceExecutionTarget,
  updateProjectExecutionTarget,
  updateWorkspaceExecutionTarget
} from './execution/project-execution-target.ts';
import {
  claimRunnerRequest,
  clearRunnerRequests,
  completeRunnerMutationRequest,
  recordBranchPrepared,
  runnerStatus,
  updateRunnerRequestStatus
} from './execution/runner.ts';
import { createEverhourExtensionRouter } from './ext/everhour/routes.ts';
import { createGitHubExtensionRouter } from './ext/github/routes.ts';
import { isAllowedBrowserOrigin } from './http/browser-origins.ts';
import { buildMeta } from './http/meta.ts';
import { resolveAuthBaseUrl } from './http/public-backend-url.ts';
import { resolveServeSpa } from './http/serve-spa.ts';
import {
  getSqlStudioState,
  initSqlStudioManager,
  syncSqlStudioForWorkspace
} from './sql-studio/sql-studio-manager.ts';
import {
  ACTIVE_WORKSPACE_COOKIE,
  auth,
  authNodeHandler,
  getAllowedBrowserOrigins,
  requireAuthenticatedSession
} from './auth.ts';
import {
  DATABASE_DIALECT,
  DATABASE_PATH,
  getActiveProfileId,
  getActiveWorkspaceIdOrNull,
  getActorWorkspaceUserId,
  initDatabase,
  WORKSPACE
} from './db.ts';
import {
  beginDesktopGitHubOAuth,
  browserOAuthCallbackUrl,
  consumeBrowserOAuthHandoff,
  consumeDesktopOAuthHandoff,
  createBrowserOAuthHandoff,
  createDesktopOAuthHandoff,
  desktopOAuthCallbackUrl
} from './desktop-oauth-handoff.ts';
import { ENV_PROFILE } from './env-profile.ts';
import { apiErrorFromDatabaseError } from './errors.ts';
import {
  handleOAuthApprove,
  handleOAuthRegister,
  handleOAuthRequestInfo,
  handleOAuthRevoke,
  handleOAuthToken,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  redirectToOAuthApproval
} from './oauth.ts';
import {
  addOrganizationAdmin,
  listOrganizationAdmins,
  listOrganizationsForUser,
  removeOrganizationAdmin,
  updateOrganization
} from './organizations.ts';
import { runProtocolSubcommand } from './protocol.ts';
import { requirePermission } from './rbac.ts';
import { readChangesAfter, realtime } from './realtime.ts';
import {
  ApiError,
  clearMissionSchedule,
  createMission,
  createObjective,
  createProject,
  createProjectResource,
  createProjectTag,
  createUserToken,
  createWorkspaceStatus,
  deleteMission,
  deleteObjective,
  deleteProject,
  deleteProjectResource,
  deleteProjectTag,
  deleteRevokedUserToken,
  deleteWorkspaceStatus,
  generateCommitMessage,
  generateMissionTitle,
  getMissionDetail,
  getMissionSchedule,
  getProfile,
  getProject,
  getProjectRepository,
  listArtifacts,
  listMissionBranches,
  listMissionEvents,
  listMissionFileChanges,
  listMissions,
  listObjectives,
  listProjectResources,
  listProjects,
  listProjectsForWorkspace,
  listProjectTags,
  listUserTokens,
  listWorkspaceMyMissions,
  listWorkspaceStatuses,
  listWorkspaceStatusesForWorkspace,
  listWorktrees,
  performBranchAction,
  previewMissionSchedule,
  purgeMergedWorktrees,
  removeWorktree,
  renameUserToken,
  reorderBoardColumn,
  reorderFutureObjectives,
  reorderProjects,
  reorderWorkspaceMyMissions,
  reorderWorkspaceStatuses,
  revokeUserToken,
  searchMissions,
  updateMission,
  updateObjective,
  updateProfile,
  updateProject,
  updateProjectResource,
  updateProjectTag,
  updateWorkspaceStatus,
  upsertMissionSchedule
} from './repository.ts';
import {
  deleteObjectiveAttachment,
  listObjectiveAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  resolveStoredObject,
  serveStoredObject,
  type UploadImageInput,
  uploadObjectiveAttachment,
  uploadOrganizationImage,
  uploadUserImage,
  uploadWorkspaceImage
} from './storage.ts';
import { webhookDispatcher } from './webhook-dispatcher.ts';
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  redeliverWebhookDelivery,
  rotateWebhookSecret,
  testWebhookSubscription,
  updateWebhookSubscription
} from './webhooks.ts';
import { readSqlStudioEnabled } from './workspace-settings.ts';
import {
  acceptWorkspaceInvitation,
  activateWorkspace,
  createOrganizationOnboarding,
  createWorkspace,
  deleteWorkspace,
  exportWorkspaceObjectivesCsv,
  inviteWorkspaceMember,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  listWorkspaces,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  updateWorkspace,
  updateWorkspaceMemberRole
} from './workspaces.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// The built SPA. Defaults to `webapp/dist` next to this module (repo + server
// bundle layouts both resolve correctly); the packaged desktop overrides it with
// OVERLORD_WEBAPP_DIST so the embedded server serves the bundled static assets.
const distDir = process.env.OVERLORD_WEBAPP_DIST
  ? path.resolve(process.env.OVERLORD_WEBAPP_DIST)
  : path.resolve(here, '..', 'dist');

const MIN_BACKEND_NODE_MAJOR = 24;

function assertSupportedBackendNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

  if (Number.isNaN(major) || major < MIN_BACKEND_NODE_MAJOR) {
    throw new Error(
      `Overlord backend requires Node.js ${MIN_BACKEND_NODE_MAJOR} or newer. Found ${process.version}.`
    );
  }
}

// Source-server development reads `.env.local` only; the bundled production server
// reads `.env.prod` only (shared detection in `./env-profile.ts`). Explicit shell
// exports win over both.
assertSupportedBackendNodeVersion();

const config = loadConfig(undefined, ENV_PROFILE);

// Precedence for every key below is profile-aware — see `resolveLayeredEnv`.
function resolveLayered(envKey: string, configValue: string): string {
  return resolveLayeredEnv({ envKey, configValue, envProfile: ENV_PROFILE });
}

const bindHost = resolveLayered('OVERLORD_WEB_HOST', config.webHost);
const bindPort = parsePort(
  resolveLayered('OVERLORD_WEB_PORT', String(config.webPort)),
  'OVERLORD_WEB_PORT'
);
const sqlStudioHost = resolveLayered('OVERLORD_SQL_STUDIO_HOST', config.sqlStudioHost);
const sqlStudioPort = parsePort(
  resolveLayered('OVERLORD_SQL_STUDIO_PORT', String(config.sqlStudioPort)),
  'OVERLORD_SQL_STUDIO_PORT'
);
const sqlStudioBinary = resolveLayered('OVERLORD_SQL_STUDIO_BINARY', config.sqlStudioBinary);
const mcpEnabled = process.env.OVERLORD_MCP_ENABLED === 'true';

initSqlStudioManager({
  binary: sqlStudioBinary,
  host: sqlStudioHost,
  port: sqlStudioPort,
  databasePath: DATABASE_PATH
});

const envSqlStudioEnabled =
  isExplicitRuntimeEnv('OVERLORD_SQL_STUDIO_ENABLED') &&
  process.env.OVERLORD_SQL_STUDIO_ENABLED === 'true'
    ? true
    : isExplicitRuntimeEnv('OVERLORD_SQL_STUDIO_ENABLED') &&
        process.env.OVERLORD_SQL_STUDIO_ENABLED === 'false'
      ? false
      : null;

function parsePort(value: string, name: string): number {
  const port = Number(value.trim());
  if (Number.isInteger(port) && port >= 0 && port < 65536) return port;
  throw new Error(`${name} must be an integer port from 0 to 65535; got ${JSON.stringify(value)}`);
}

const app = express();
const allowedBrowserOrigins = getAllowedBrowserOrigins();
app.use(
  cors({
    origin(origin, callback) {
      // Non-browser clients and same-origin requests omit Origin.
      if (!origin || isAllowedBrowserOrigin(origin, allowedBrowserOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Upload-Filename',
      'X-Overlord-Active-Workspace',
      'X-Overlord-Device-Fingerprint',
      'X-Overlord-Device-Label',
      'X-Overlord-Device-Platform'
    ],
    // Better Auth bearer plugin returns the session token here for cross-origin
    // clients (desktop remote mode, CLI). Without this, the renderer cannot read
    // the header after sign-in and loops back to the login screen.
    exposedHeaders: ['set-auth-token']
  })
);
// Better Auth owns `/api/auth/*` except this browser-to-desktop handoff. The
// browser session becomes a one-time opaque ticket; only Electron main may
// exchange it for the session token, so no credential is placed in the URL.
app.get('/api/auth/desktop/github', async (_req, res, next) => {
  try {
    const oauthResponse = await beginDesktopGitHubOAuth(auth, resolveAuthBaseUrl());
    if (!oauthResponse.ok) {
      const body = await oauthResponse.text();
      res.status(oauthResponse.status).type('application/json').send(body);
      return;
    }

    const payload = (await oauthResponse.json()) as { url?: unknown };
    if (typeof payload.url !== 'string' || !payload.url) {
      throw new Error('Better Auth did not return a GitHub authorization URL');
    }
    for (const cookie of oauthResponse.headers.getSetCookie()) res.append('Set-Cookie', cookie);
    res.redirect(302, payload.url);
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/desktop/callback', async (req, res, next) => {
  try {
    const browserSession = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!browserSession?.session.token) {
      res
        .status(401)
        .send('Your sign-in session is missing or expired. Return to Overlord and try again.');
      return;
    }
    res.redirect(
      302,
      desktopOAuthCallbackUrl(createDesktopOAuthHandoff(browserSession.session.token))
    );
  } catch (error) {
    next(error);
  }
});

function browserOAuthReturnOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    return isAllowedBrowserOrigin(origin, getAllowedBrowserOrigins()) ? origin : null;
  } catch {
    return null;
  }
}

app.get('/api/auth/browser/callback', async (req, res, next) => {
  try {
    const returnOrigin = browserOAuthReturnOrigin(req.query.returnTo);
    if (!returnOrigin) {
      res.status(400).send('The requested sign-in return origin is not allowed.');
      return;
    }
    const browserSession = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!browserSession?.session.token) {
      res
        .status(401)
        .send('Your sign-in session is missing or expired. Return to Overlord and try again.');
      return;
    }
    res.redirect(
      302,
      browserOAuthCallbackUrl(returnOrigin, createBrowserOAuthHandoff(browserSession.session.token))
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/desktop/exchange', express.json(), (req, res) => {
  const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
  const token = consumeDesktopOAuthHandoff(ticket);
  if (!token) {
    res.status(401).json({ message: 'This desktop sign-in link has expired or was already used.' });
    return;
  }
  res.json({ token });
});

app.post('/api/auth/browser/exchange', express.json(), (req, res) => {
  const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
  const token = consumeBrowserOAuthHandoff(ticket);
  if (!token) {
    res.status(401).json({ message: 'This browser sign-in link has expired or was already used.' });
    return;
  }
  res.json({ token });
});

app.all('/api/auth/*', authNodeHandler);

const jsonBody = express.json();
const urlEncodedBody = express.urlencoded({ extended: false });
function isRawUploadRequest(req: Request): boolean {
  if (req.method !== 'POST') return false;
  if (req.path.startsWith('/api/uploads/')) return true;
  return /^\/api\/objectives\/[^/]+\/attachments$/.test(req.path);
}

app.use((req, res, next) => {
  if (isRawUploadRequest(req)) return next();
  return jsonBody(req, res, next);
});

// Public login-provider advertisement. Mounted BEFORE the `/api`
// authentication guard because the login screen renders pre-authentication and
// must know whether to show "Continue with GitHub" without a session. Carries
// no secrets — only which providers are configured. `/api/meta` echoes the same
// shape for authenticated surfaces (e.g. account linking); both derive from
// `githubOAuthConfigFromEnv` so they cannot drift.
app.get('/api/auth-providers', (_req, res) => {
  res.json({ email: true, github: githubOAuthConfigFromEnv() !== null });
});

/**
 * Persist which workspace a browser session defaults to on future requests
 * (the per-user replacement for the old process-global active workspace —
 * see `ensureWorkspaceUser`/`ACTIVE_WORKSPACE_COOKIE` in `backend/auth.ts`).
 * `httpOnly` + `sameSite: 'lax'` since this is a same-site preference, not a
 * credential; membership is still re-validated from `workspace_users` on every
 * request, so a forged/stale value only ever downgrades to a 403 or the
 * caller's default membership, never an escalation.
 */
function setActiveWorkspaceCookie(res: Response, workspaceId: string): void {
  res.cookie(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: res.req.secure,
    path: '/',
    maxAge: 400 * 24 * 60 * 60 * 1000
  });
}

// Small wrapper so handlers can throw ApiError / Error and get a clean response.
// Also triggers an immediate realtime poll after mutations for snappy echoes.
// `requires` declares the RBAC permission the route needs; it is enforced (role
// grants ∩ token scope) before the handler runs, so a scoped USER_TOKEN — or any
// under-privileged actor — is rejected uniformly with a 403.
function handle(
  fn: (req: Request, res: Response) => unknown,
  options: { mutates?: boolean; requires?: Permission } = {}
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        if (options.requires) await requirePermission(options.requires);
        const result = await Promise.resolve(fn(req, res));
        if (options.mutates) {
          realtime.pollNow();
          webhookDispatcher.pollNow();
        }
        if (!res.headersSent) res.json(result ?? { ok: true });
      } catch (err) {
        next(err);
      }
    })();
  };
}

// ---- Meta / health -------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json(oauthProtectedResourceMetadata(req));
});
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json(oauthProtectedResourceMetadata(req));
});
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(oauthAuthorizationServerMetadata(req));
});
app.get('/oauth/authorize', redirectToOAuthApproval);
app.post('/oauth/register', urlEncodedBody, handleOAuthRegister);
app.post('/oauth/token', urlEncodedBody, (req, res, next) => {
  void handleOAuthToken(req, res).catch(next);
});
app.post('/oauth/revoke', urlEncodedBody, (req, res, next) => {
  void handleOAuthRevoke(req, res).catch(next);
});
app.post('/oauth/authorize/request', requireAuthenticatedSession, handle(handleOAuthRequestInfo));
app.post(
  '/oauth/authorize/approve',
  requireAuthenticatedSession,
  handle(
    async (req, res) => {
      await handleOAuthApprove(req, res);
    },
    { mutates: true }
  )
);

if (mcpEnabled) {
  app.get('/mcp', requireAuthenticatedSession, (req, res) => {
    res.json(mcpServerInfo(req));
  });
  app.post('/mcp', requireAuthenticatedSession, (req, res, next) => {
    void (async () => {
      await handleMcpPost(req, res, next);
      realtime.pollNow();
      webhookDispatcher.pollNow();
    })().catch(next);
  });
}

app.use('/api', requireAuthenticatedSession);

app.get(
  '/api/meta',
  handle(
    async () => ({
      ...(await buildMeta()),
      databasePath: DATABASE_PATH,
      // Hosted Postgres deployments have no overlord.toml, so config.backendMode
      // defaults to local. Infer cloud for the SPA and other API consumers.
      backendMode: DATABASE_DIALECT === 'postgres' ? 'cloud' : config.backendMode,
      web: {
        host: bindHost,
        port: bindPort,
        url: `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`
      },
      sqlStudio: getSqlStudioState(),
      // Which interactive login providers this build offers, so the auth UI can
      // show/hide the "Continue with GitHub" button without hardcoding cloud vs
      // local. `email` is always available; `github` only when OAuth creds are
      // configured (see `githubOAuthConfigFromEnv`).
      authProviders: {
        email: true,
        github: githubOAuthConfigFromEnv() !== null
      },
      // Capabilities scoped to what this build supports. Launching queues
      // execution requests for a runner; execution-target management remains
      // CLI-only.
      capabilities: {
        projects: true,
        missions: true,
        objectives: true,
        realtime: true,
        sqlStudio: getSqlStudioState().enabled,
        launchAgents: true,
        executionTargets: false,
        localTarget: resolveLocalTargetServerCapability({ dialect: DATABASE_DIALECT }),
        mcp: mcpEnabled
      }
    }),
    {}
  )
);

app.get(
  '/api/diagnostics/execution-target-migration',
  handle(() => getExecutionTargetMigrationDiagnostics(), {
    requires: PERMISSIONS.WORKSPACE_READ
  })
);

// ---- Onboarding -----------------------------------------------------------
//
// Combined organization + first-workspace onboarding for an authenticated
// profile with zero workspace memberships anywhere (Q10). Shared verbatim by
// the web onboarding screen and the future `ovld org-setup` CLI command.
// Deliberately carries no `requires` gate — it is the mechanism that grants
// the caller's *first* membership, so there is nothing to check permission
// against yet; `createOrganizationOnboarding` itself refuses a profile that
// already has a membership.

app.post(
  '/api/onboarding',
  handle(
    async (req, res) => {
      const result = await createOrganizationOnboarding(req.body);
      setActiveWorkspaceCookie(res, result.id);
      realtime.refreshAll();
      return buildMeta();
    },
    { mutates: true }
  )
);

// ---- Organizations --------------------------------------------------------
//
// The grouping + identity layer above workspaces. "Organization admin" is a
// derived concept (ADMIN of every constituent workspace, see
// backend/rbac.ts) rather than a stored role, so these routes carry no
// `requires` gate — each service function in backend/organizations.ts
// enforces its own org-admin (or org-admin-in-at-least-one-workspace) check.

app.get(
  '/api/organizations',
  handle(async () => {
    const profileId = getActiveProfileId();
    if (!profileId) throw new ApiError(401, 'Authentication required');
    return listOrganizationsForUser(profileId);
  })
);
app.patch(
  '/api/organizations/:id',
  handle(
    async req => {
      const result = await updateOrganization(req.params.id, req.body);
      realtime.refreshAll();
      return result;
    },
    { mutates: true }
  )
);
app.get(
  '/api/organizations/:id/admins',
  handle(req => listOrganizationAdmins(req.params.id))
);
app.post(
  '/api/organizations/:id/admins',
  handle(req => addOrganizationAdmin(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/organizations/:id/admins/:userId',
  handle(req => removeOrganizationAdmin(req.params.id, { userId: req.params.userId }), {
    mutates: true
  })
);

// ---- Workspaces ----------------------------------------------------------
//
// One database can hold many workspaces and the operator can belong to several.
// Switching the active workspace changes what every other scoped query returns,
// so both routes force a coarse realtime refresh to resync all subscribers.

app.get(
  '/api/workspaces',
  handle(async () => {
    if (getActorWorkspaceUserId()) await requirePermission(PERMISSIONS.WORKSPACE_READ);
    return listWorkspaces();
  })
);
app.post(
  '/api/workspaces',
  handle(
    async (req, res) => {
      if (getActorWorkspaceUserId()) await requirePermission(PERMISSIONS.WORKSPACE_CREATE);
      const result = await createWorkspace(req.body);
      setActiveWorkspaceCookie(res, result.id);
      realtime.refreshAll();
      return result;
    },
    { mutates: true }
  )
);
app.patch(
  '/api/workspaces/:id',
  handle(
    async req => {
      const result = await updateWorkspace(req.params.id, req.body);
      // Renaming the active workspace changes `/api/meta`, so resync everyone.
      if (result.isActive) realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_UPDATE }
  )
);
app.delete(
  '/api/workspaces/:id',
  handle(
    async (req, res) => {
      const result = await deleteWorkspace(req.params.id);
      // Deleting may switch the active workspace: re-point this session's
      // preference cookie so it never keeps referencing the deleted workspace.
      const active = result.find(workspace => workspace.isActive);
      if (active) setActiveWorkspaceCookie(res, active.id);
      // Resync all subscribers.
      realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_DELETE }
  )
);
// `listWorkspaceMembers` validates active membership in the *target* workspace
// itself (`requireWorkspaceMember`), so this route carries no route-level
// `requires` gate — a route-level check would only validate the caller's
// active workspace, which is wrong when e.g. the mission assignee selector
// requests members of a secondary (non-active) workspace (coo:135).
app.get(
  '/api/workspaces/:id/members',
  handle(req => listWorkspaceMembers(req.params.id))
);
app.delete(
  '/api/workspaces/:id/members/:workspaceUserId',
  handle(req => removeWorkspaceMember(req.params.id, req.params.workspaceUserId), {
    mutates: true,
    requires: PERMISSIONS.MEMBER_REMOVE
  })
);
app.patch(
  '/api/workspaces/:id/members/:workspaceUserId/role',
  handle(req => updateWorkspaceMemberRole(req.params.id, req.params.workspaceUserId, req.body), {
    mutates: true,
    requires: PERMISSIONS.ROLE_ASSIGN
  })
);
app.get(
  '/api/workspaces/:id/invitations',
  handle(req => listWorkspaceInvitations(req.params.id), {
    requires: PERMISSIONS.INVITATION_READ
  })
);
app.post(
  '/api/workspaces/:id/invitations',
  handle(req => inviteWorkspaceMember(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.MEMBER_INVITE
  })
);
app.delete(
  '/api/workspaces/:id/invitations/:invitationId',
  handle(req => revokeWorkspaceInvitation(req.params.id, req.params.invitationId), {
    mutates: true,
    requires: PERMISSIONS.INVITATION_REVOKE
  })
);
// Accepting an invitation is how a brand-new (or not-yet-a-member) authenticated
// profile gains its first workspace membership, so this route deliberately
// carries no `requires` gate — the invitation token itself is the credential.
app.post(
  '/api/invitations/accept',
  handle(
    async (req, res) => {
      const result = await acceptWorkspaceInvitation(req.body);
      setActiveWorkspaceCookie(res, result.id);
      realtime.refreshAll();
      return result;
    },
    { mutates: true }
  )
);
app.get(
  '/api/workspaces/:id/objectives.csv',
  handle(
    async (req, res) => {
      const exportFile = await exportWorkspaceObjectivesCsv(req.params.id);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFile.filename}"`);
      res.send(exportFile.content);
    },
    { requires: PERMISSIONS.WORKSPACE_READ }
  )
);
app.post(
  '/api/workspaces/:id/activate',
  handle(
    async (req, res) => {
      const result = await activateWorkspace(req.params.id);
      setActiveWorkspaceCookie(res, req.params.id);
      realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_ACTIVATE }
  )
);
// Per-workspace project listing, now that the sidebar can render every
// accessible workspace of the active organization at once. Membership is
// validated against `req.params.id` specifically (not necessarily the
// caller's currently active workspace) inside `listProjectsForWorkspace`.
app.get(
  '/api/workspaces/:id/projects',
  handle(req => listProjectsForWorkspace(req.params.id))
);
app.get(
  '/api/workspaces/:id/statuses',
  handle(req => listWorkspaceStatusesForWorkspace(req.params.id))
);
app.get(
  '/api/workspaces/:id/execution-targets',
  handle(req => getWorkspaceExecutionTargets(req.params.id))
);
app.patch(
  '/api/workspaces/:id/execution-targets/:targetId',
  handle(req => updateWorkspaceExecutionTarget(req.params.id, req.params.targetId, req.body), {
    mutates: true
  })
);
app.delete(
  '/api/workspaces/:id/execution-targets/:targetId',
  handle(
    async req => {
      await removeWorkspaceExecutionTarget(req.params.id, req.params.targetId);
      return { ok: true as const };
    },
    { mutates: true }
  )
);
// Workspace-scoped status CRUD. Unlike the legacy `/api/workspace/statuses`
// routes (active-workspace only), these target the `:id` workspace and
// authorize `workspace:update` there inside the service, so the settings modal
// can manage any org workspace's statuses without switching to it (coo:135).
app.post(
  '/api/workspaces/:id/statuses',
  handle(req => createWorkspaceStatus(req.body, req.params.id), { mutates: true })
);
app.patch(
  '/api/workspaces/:id/statuses/reorder',
  handle(req => reorderWorkspaceStatuses(req.body, req.params.id), { mutates: true })
);
app.patch(
  '/api/workspaces/:id/statuses/:statusId',
  handle(req => updateWorkspaceStatus(req.params.statusId, req.body, req.params.id), {
    mutates: true
  })
);
app.delete(
  '/api/workspaces/:id/statuses/:statusId',
  handle(
    async req => {
      await deleteWorkspaceStatus(req.params.statusId, req.params.id);
      return { ok: true as const };
    },
    { mutates: true }
  )
);
// Workspace-scoped agent catalog. Unlike the legacy `/api/agent-catalog`
// routes (active-workspace only), these target the `:id` workspace and
// authorize `launch:read`/`launch:configure` against that workspace's own
// membership inside the service, so the settings modal can manage any
// accessible workspace's model catalog without switching to it (coo:324).
app.get(
  '/api/workspaces/:id/agent-catalog',
  handle(req => getAgentCatalog(req.params.id))
);
app.put(
  '/api/workspaces/:id/agent-catalog',
  handle(req => updateAgentCatalog(req.body, req.params.id), { mutates: true })
);
app.post(
  '/api/workspaces/:id/agent-catalog/refresh',
  handle(req => refreshAgentCatalog(req.params.id), { mutates: true })
);

// ---- Profile -------------------------------------------------------------
//
// The local operator's user-account profile. This build runs as a single
// trusted local user, so the profile maps directly to that operator's row in
// the `users` table.

app.get(
  '/api/profile',
  handle(() => getProfile(), { requires: PERMISSIONS.PROFILE_SELF_READ })
);
app.patch(
  '/api/profile',
  handle(req => updateProfile(req.body), {
    mutates: true,
    requires: PERMISSIONS.PROFILE_SELF_UPDATE
  })
);

// ---- User tokens ---------------------------------------------------------
//
// Long-lived `USER_TOKEN` credentials owned by the authenticated user account,
// independent of workspace. Raw secrets are returned only from create;
// list/rename/revoke never expose them. Revoke is a state change retained for
// audit; only an already-revoked token may later be soft-deleted.

app.get(
  '/api/user-tokens',
  handle(() => listUserTokens(), { requires: PERMISSIONS.USER_TOKEN_SELF_LIST })
);
app.post(
  '/api/user-tokens',
  handle(req => createUserToken(req.body), {
    mutates: true,
    requires: PERMISSIONS.USER_TOKEN_SELF_CREATE
  })
);
app.patch(
  '/api/user-tokens/:id',
  handle(req => renameUserToken(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.USER_TOKEN_SELF_ROTATE
  })
);
app.post(
  '/api/user-tokens/:id/revoke',
  handle(req => revokeUserToken(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.USER_TOKEN_SELF_REVOKE
  })
);
app.delete(
  '/api/user-tokens/:id',
  handle(
    async (req, res) => {
      await deleteRevokedUserToken(req.params.id);
      res.status(204).end();
    },
    {
      mutates: true,
      requires: PERMISSIONS.USER_TOKEN_SELF_REVOKE
    }
  )
);

// ---- Webhooks (coo:115) ---------------------------------------------------
//
// Workspace-scoped webhook subscription management. ADMIN-gated by default
// (see overlord.rbac.toml -> permission_groups.webhook_management).
// Deliveries themselves are dispatched by the in-process worker in
// backend/webhook-dispatcher.ts, not from these handlers.

app.get(
  '/api/webhooks',
  handle(() => listWebhookSubscriptions(), { requires: PERMISSIONS.WEBHOOK_READ })
);
app.post(
  '/api/webhooks',
  handle(req => createWebhookSubscription(req.body), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_CREATE
  })
);
app.patch(
  '/api/webhooks/:id',
  handle(req => updateWebhookSubscription(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_UPDATE
  })
);
app.delete(
  '/api/webhooks/:id',
  handle(req => deleteWebhookSubscription(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_DELETE
  })
);
app.post(
  '/api/webhooks/:id/rotate-secret',
  handle(req => rotateWebhookSecret(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_UPDATE
  })
);
app.post(
  '/api/webhooks/:id/test',
  handle(req => testWebhookSubscription(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_UPDATE
  })
);
app.get(
  '/api/webhooks/:id/deliveries',
  handle(
    req =>
      listWebhookDeliveries(req.params.id, {
        before: typeof req.query.before === 'string' ? req.query.before : null,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
      }),
    { requires: PERMISSIONS.WEBHOOK_READ }
  )
);
app.post(
  '/api/webhooks/:id/deliveries/:outboxId/redeliver',
  handle(req => redeliverWebhookDelivery(req.params.id, req.params.outboxId), {
    mutates: true,
    requires: PERMISSIONS.WEBHOOK_UPDATE
  })
);

// ---- Uploads / storage ---------------------------------------------------
//
// The core upload service. `POST /api/uploads/:bucketKey` accepts raw image
// bytes (the SPA streams a single File as the request body), persists them to
// the bucket's storage backend, records provider-neutral metadata, and returns
// a descriptor whose `url` serves the bytes back. `user-images` and
// `workspace-images` are wired today; the surface is generic so other image
// buckets can reuse it. Each bucket key requires its own permission (checked
// inside the handler, since `requires` on `handle()` is fixed per route), so
// e.g. only workspace admins can upload a workspace logo.
//
// The body is parsed as a raw Buffer here (overriding the global JSON parser for
// this route) with the same ceiling the service enforces.

const rawImageBody = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });

const UPLOAD_HANDLERS: Record<
  string,
  { permission: Permission; upload: (input: UploadImageInput) => Promise<StoredImageDto> }
> = {
  'user-images': { permission: PERMISSIONS.USER_IMAGE_SELF_CREATE, upload: uploadUserImage },
  'workspace-images': {
    permission: PERMISSIONS.WORKSPACE_IMAGE_CREATE,
    upload: uploadWorkspaceImage
  },
  'organization-images': {
    permission: PERMISSIONS.ORGANIZATION_IMAGE_CREATE,
    upload: uploadOrganizationImage
  }
};

const STORAGE_READ_PERMISSIONS: Record<string, Permission> = {
  'user-images': PERMISSIONS.USER_IMAGE_READ,
  'workspace-images': PERMISSIONS.WORKSPACE_IMAGE_READ,
  'organization-images': PERMISSIONS.ORGANIZATION_IMAGE_READ,
  attachments: PERMISSIONS.ATTACHMENT_READ
};

app.post(
  '/api/uploads/:bucketKey',
  rawImageBody,
  handle(
    async req => {
      const uploadHandler = UPLOAD_HANDLERS[req.params.bucketKey];
      if (!uploadHandler) {
        throw new ApiError(404, `Uploads are not configured for bucket '${req.params.bucketKey}'`);
      }
      await requirePermission(uploadHandler.permission);
      const headerName = req.header('x-upload-filename');
      const filename = headerName ? decodeURIComponent(headerName) : 'upload';
      return uploadHandler.upload({
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        filename,
        contentType: req.header('content-type') ?? ''
      });
    },
    { mutates: true }
  )
);

// Serve stored object bytes. The lookup is by exact backend key against the
// recorded (non-deleted) metadata row, so only known objects are served and the
// `storageKey` path segment cannot traverse the filesystem. Attachments carry
// arbitrary, user-supplied bytes, so they are served as downloads with
// `nosniff` to prevent the browser from rendering them inline (e.g. HTML/SVG).
app.get(
  '/api/storage/:bucketKey/:storageKey',
  (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const permission = STORAGE_READ_PERMISSIONS[req.params.bucketKey];
        if (!permission) {
          throw new ApiError(404, `Serving is not configured for bucket '${req.params.bucketKey}'`);
        }
        await requirePermission(permission);
        const resolved = await resolveStoredObject(req.params.bucketKey, req.params.storageKey);
        res.type(resolved.contentType);
        if (resolved.presignedRedirectUrl) {
          res.setHeader('Cache-Control', 'private, no-store');
        } else {
          res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        }
        if (resolved.forceDownload) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          if (!resolved.presignedRedirectUrl) {
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${encodeURIComponent(resolved.filename)}"`
            );
          }
        }
        serveStoredObject(res, resolved);
      } catch (err) {
        next(err);
      }
    })();
  }
);

// ---- Realtime ------------------------------------------------------------

function parseSeqCursor(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function streamRealtime(req: Request, res: Response): void {
  void (async () => {
    try {
      await requirePermission(PERMISSIONS.PROJECT_READ);
    } catch {
      res.status(403).json({ error: 'Permission denied: realtime stream' });
      return;
    }
    const afterSeq =
      parseSeqCursor(req.query.after) ?? parseSeqCursor(req.headers['last-event-id']) ?? undefined;
    realtime.addClient(res, { afterSeq });
    req.on('close', () => realtime.removeClient(res));
  })();
}

app.get('/api/stream', streamRealtime);
app.get('/realtime', requireAuthenticatedSession, streamRealtime);
app.get(
  '/sync/changes',
  requireAuthenticatedSession,
  (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        await requirePermission(PERMISSIONS.PROJECT_READ);
      } catch {
        res.status(403).json({ error: 'Permission denied: realtime catch-up' });
        return;
      }

      try {
        const afterSeq = parseSeqCursor(req.query.after);
        if (afterSeq === null) {
          res.status(400).json({ error: 'Query parameter "after" must be a non-negative integer' });
          return;
        }
        res.json(await readChangesAfter(afterSeq));
      } catch (err) {
        next(err);
      }
    })();
  }
);

// ---- Projects ------------------------------------------------------------

app.get(
  '/api/projects',
  handle(() => listProjects(), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/projects',
  handle(req => createProject(req.body), { mutates: true })
);
app.patch(
  '/api/projects/reorder',
  handle(req => reorderProjects(req.body), { mutates: true })
);
app.get(
  '/api/projects/:id',
  handle(req => getProject(req.params.id))
);
app.patch(
  '/api/projects/:id',
  handle(req => updateProject(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/projects/:id',
  handle(req => deleteProject(req.params.id), { mutates: true })
);
app.get(
  '/api/workspace/statuses',
  handle(() => listWorkspaceStatuses(), { requires: PERMISSIONS.WORKSPACE_READ })
);
app.post(
  '/api/workspace/statuses',
  handle(req => createWorkspaceStatus(req.body), {
    mutates: true,
    requires: PERMISSIONS.WORKSPACE_UPDATE
  })
);
app.patch(
  '/api/workspace/statuses/reorder',
  handle(req => reorderWorkspaceStatuses(req.body), {
    mutates: true,
    requires: PERMISSIONS.WORKSPACE_UPDATE
  })
);
app.patch(
  '/api/workspace/statuses/:statusId',
  handle(req => updateWorkspaceStatus(req.params.statusId, req.body), {
    mutates: true,
    requires: PERMISSIONS.WORKSPACE_UPDATE
  })
);
app.delete(
  '/api/workspace/statuses/:statusId',
  handle(
    req => {
      deleteWorkspaceStatus(req.params.statusId);
      return { ok: true as const };
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_UPDATE }
  )
);

// ---- My Missions (selected-workspace aggregate) ---------------------------
app.get(
  '/api/workspace/my-missions',
  handle(() => listWorkspaceMyMissions(), { requires: PERMISSIONS.MISSION_READ })
);
app.patch(
  '/api/workspace/my-missions/order',
  handle(req => reorderWorkspaceMyMissions(req.body), {
    mutates: true,
    requires: PERMISSIONS.MISSION_UPDATE
  })
);

app.get(
  '/api/projects/:id/tags',
  handle(req => listProjectTags(req.params.id))
);
app.post(
  '/api/projects/:id/tags',
  handle(req => createProjectTag(req.params.id, req.body), {
    mutates: true
  })
);
app.patch(
  '/api/projects/:id/tags/:tagId',
  handle(req => updateProjectTag(req.params.id, req.params.tagId, req.body), {
    mutates: true
  })
);
app.delete(
  '/api/projects/:id/tags/:tagId',
  handle(
    req => {
      deleteProjectTag(req.params.id, req.params.tagId);
      return { ok: true as const };
    },
    { mutates: true }
  )
);
app.get(
  '/api/projects/:id/resources',
  handle(req => listProjectResources(req.params.id))
);
app.post(
  '/api/projects/:id/resources',
  handle(req => createProjectResource(req.params.id, req.body), {
    mutates: true
  })
);
app.patch(
  '/api/projects/:id/resources/:resourceId',
  handle(req => updateProjectResource(req.params.id, req.params.resourceId, req.body), {
    mutates: true
  })
);
app.delete(
  '/api/projects/:id/resources/:resourceId',
  handle(
    req => {
      deleteProjectResource(req.params.id, req.params.resourceId);
      return { ok: true as const };
    },
    { mutates: true }
  )
);
app.get(
  '/api/projects/:id/repository',
  handle(req => {
    const executionTargetId =
      typeof req.query.executionTargetId === 'string' && req.query.executionTargetId.trim()
        ? req.query.executionTargetId.trim()
        : null;
    const resourceKey =
      typeof req.query.resourceKey === 'string' && req.query.resourceKey.trim()
        ? req.query.resourceKey.trim()
        : null;
    return getProjectRepository(req.params.id, executionTargetId, resourceKey);
  })
);
app.post(
  '/api/local-target/invoke',
  handle(
    req => {
      const call = req.body as { capability?: unknown; input?: unknown };
      if (!call?.capability || !call?.input) {
        throw new ApiError(400, 'A local-target capability call is required.');
      }
      return invokeLocalTargetOnServer({
        dialect: DATABASE_DIALECT,
        call: call as LocalTargetBridgeCall
      });
    },
    { requires: PERMISSIONS.PROJECT_READ }
  )
);
app.get(
  '/api/projects/:id/missions',
  handle(req => listMissions(req.params.id))
);

// Extension routers must run behind `requireAuthenticatedSession` exactly like
// every `/api` route: it establishes the per-request context and resolves the
// caller's active workspace from the `X-Overlord-Active-Workspace` header/cookie
// (see `setActiveWorkspaceContext` in `backend/auth.ts`). Without it these routes
// fall back to the process-global default workspace, so linking a project that
// lives in any non-default workspace scopes the lookup to the wrong tenant and
// 404s ("Project not found") even though the project exists.
app.use('/ext/everhour', requireAuthenticatedSession, createEverhourExtensionRouter(handle));
app.use('/ext/github', requireAuthenticatedSession, createGitHubExtensionRouter(handle));
app.patch(
  '/api/projects/:id/board/reorder',
  handle(req => reorderBoardColumn(req.params.id, req.body), {
    mutates: true
  })
);

// ---- Missions -------------------------------------------------------------

app.get(
  '/api/missions/search',
  handle(async req => {
    const query = typeof req.query.q === 'string' ? req.query.q : null;
    const projectId =
      typeof req.query.projectId === 'string' && req.query.projectId.trim()
        ? req.query.projectId.trim()
        : null;
    const parsedLimit = Number.parseInt(
      typeof req.query.limit === 'string' ? req.query.limit : '',
      10
    );
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    return { missions: await searchMissions({ query, projectId, limit }) };
  })
);
// `createMission`/`getMissionDetail`/`updateMission`/`deleteMission` resolve and
// authorize against the mission's (or target project's) own workspace
// internally (coo:135) — mirroring `GET /api/projects/:id` above — so these
// routes carry no route-level `requires` gate; a route-level check would only
// ever validate the caller's *active* workspace, which is wrong for a
// secondary-workspace mission.
app.post(
  '/api/missions',
  handle(req => createMission(req.body), { mutates: true })
);
app.get(
  '/api/missions/:id',
  handle(req => getMissionDetail(req.params.id))
);
app.patch(
  '/api/missions/:id',
  handle(req => updateMission(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/missions/:id',
  handle(req => deleteMission(req.params.id), { mutates: true })
);
app.post(
  '/api/missions/:id/generate-title',
  handle(req => generateMissionTitle(req.params.id), { mutates: true })
);
app.post(
  '/api/missions/:id/generate-commit-message',
  handle(req => generateCommitMessage(req.params.id, req.body ?? {}))
);
app.get(
  '/api/missions/:id/objectives',
  handle(req => listObjectives(req.params.id))
);
app.patch(
  '/api/missions/:id/objectives/reorder',
  handle(req => reorderFutureObjectives(req.params.id, req.body), { mutates: true })
);
app.get(
  '/api/missions/:id/events',
  handle(req => listMissionEvents(req.params.id))
);
app.get(
  '/api/missions/:id/artifacts',
  handle(req => listArtifacts(req.params.id))
);
app.get(
  '/api/missions/:id/file-changes',
  handle(req => listMissionFileChanges(req.params.id))
);
app.post(
  '/api/missions/schedule/preview',
  handle(req => previewMissionSchedule(req.body), { requires: PERMISSIONS.MISSION_READ })
);
app.get(
  '/api/missions/:id/schedule',
  handle(req => getMissionSchedule(req.params.id))
);
app.put(
  '/api/missions/:id/schedule',
  handle(req => upsertMissionSchedule(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/missions/:id/schedule',
  handle(req => clearMissionSchedule(req.params.id), { mutates: true })
);

// ---- Objectives ----------------------------------------------------------
//
// `createObjective`/`updateObjective`/`deleteObjective` resolve and authorize
// against the mission's/objective's own workspace internally (coo:135), so
// these routes carry no route-level `requires` gate either.

app.post(
  '/api/objectives',
  handle(req => createObjective(req.body), { mutates: true })
);
app.patch(
  '/api/objectives/:id',
  handle(req => updateObjective(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/objectives/:id',
  handle(req => deleteObjective(req.params.id), { mutates: true })
);
app.post(
  '/api/objectives/:id/launch',
  handle(req => launchObjective(req.params.id, req.body), { mutates: true })
);
app.get(
  '/api/objectives/:id/prompt',
  handle(req => getObjectivePrompt(req.params.id))
);

// ---- Objective attachments -----------------------------------------------
//
// Drag-and-drop file uploads linked to an objective. Like the image upload
// service, the SPA streams a single File as the raw request body (filename in a
// header) so the server records it without multipart parsing.

const rawAttachmentBody = express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });

app.get(
  '/api/objectives/:id/attachments',
  handle(req => listObjectiveAttachments(req.params.id), { requires: PERMISSIONS.ATTACHMENT_READ })
);
app.post(
  '/api/objectives/:id/attachments',
  rawAttachmentBody,
  handle(
    req => {
      const headerName = req.header('x-upload-filename');
      const filename = headerName ? decodeURIComponent(headerName) : 'attachment';
      return uploadObjectiveAttachment({
        objectiveId: req.params.id,
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        filename,
        contentType: req.header('content-type') ?? ''
      });
    },
    { mutates: true, requires: PERMISSIONS.ATTACHMENT_CREATE }
  )
);
app.delete(
  '/api/objectives/:id/attachments/:attachmentId',
  handle(req => deleteObjectiveAttachment(req.params.id, req.params.attachmentId), {
    mutates: true,
    requires: PERMISSIONS.ATTACHMENT_DELETE
  })
);

// ---- Agent catalog and launch configuration -------------------------------

app.get(
  '/api/agent-catalog',
  handle(() => getAgentCatalog(), { requires: PERMISSIONS.LAUNCH_READ })
);
app.post(
  '/api/agent-catalog/refresh',
  handle(() => refreshAgentCatalog(), { mutates: true, requires: PERMISSIONS.LAUNCH_CONFIGURE })
);
app.put(
  '/api/agent-catalog',
  handle(req => updateAgentCatalog(req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
);
app.get(
  '/api/launch-settings',
  handle(() => getLaunchSettings(), { requires: PERMISSIONS.LAUNCH_READ })
);
app.patch(
  '/api/launch-settings/agents/:agentKey',
  handle(req => updateAgentLaunchConfig(req.params.agentKey, req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
);
app.patch(
  '/api/launch-settings/terminal-profile',
  handle(req => updateTerminalProfile(req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
);
app.patch(
  '/api/launch-settings/worktree-branch-automation',
  handle(req => updateWorktreeBranchAutomation(req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
);
// Workspace-scoped launch settings. Unlike the legacy `/api/launch-settings`
// routes (active-workspace only), these target the `:id` workspace and authorize
// `launch:read`/`launch:configure` against that workspace's own membership inside
// the service, so a mission running in a secondary workspace reads and writes its
// agent launch config (pre-command + flags) in that workspace — matching where
// `launchObjective` resolves it (coo:331 Phase 0). Omitting the id keeps the
// legacy active-workspace behavior above.
app.get(
  '/api/workspaces/:id/launch-settings',
  handle(req => getLaunchSettings(req.params.id))
);
app.patch(
  '/api/workspaces/:id/launch-settings/agents/:agentKey',
  handle(req => updateAgentLaunchConfig(req.params.agentKey, req.body, req.params.id), {
    mutates: true
  })
);
app.patch(
  '/api/workspaces/:id/launch-settings/terminal-profile',
  handle(req => updateTerminalProfile(req.body, req.params.id), { mutates: true })
);
app.patch(
  '/api/workspaces/:id/launch-settings/worktree-branch-automation',
  handle(req => updateWorktreeBranchAutomation(req.body, req.params.id), { mutates: true })
);
// `getLaunchPreference`/`updateLaunchPreference` resolve and authorize against
// the project's own workspace internally (coo:135), so these routes carry no
// route-level `requires` gate — a mission panel open on a secondary workspace
// still needs its project's launch preference to load.
app.get(
  '/api/projects/:id/launch-preference',
  handle(req => getLaunchPreference(req.params.id))
);
app.put(
  '/api/projects/:id/launch-preference',
  handle(req => updateLaunchPreference(req.params.id, req.body), { mutates: true })
);
app.get(
  '/api/projects/:id/execution-target',
  handle(req => getProjectExecutionTarget(req.params.id), { requires: PERMISSIONS.LAUNCH_READ })
);
app.put(
  '/api/projects/:id/execution-target',
  handle(req => updateProjectExecutionTarget(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
);
app.post(
  '/api/execution-targets/:id/observations',
  handle(
    req =>
      postExecutionTargetObservations({
        executionTargetId: req.params.id,
        body: req.body
      }),
    { mutates: true }
  )
);
app.post(
  '/api/execution-targets/:id/mission-branch-observations',
  handle(
    req =>
      postMissionBranchObservations({
        executionTargetId: req.params.id,
        body: req.body
      }),
    { mutates: true }
  )
);

// ---- CLI protocol / runner ------------------------------------------------

app.post(
  '/api/protocol/:subcommand',
  handle(req => runProtocolSubcommand(req.params.subcommand, req.body ?? {}), { mutates: true })
);

app.get(
  '/api/runner/status',
  handle(
    req => {
      const projectId =
        typeof req.query.projectId === 'string' && req.query.projectId.trim()
          ? req.query.projectId.trim()
          : null;
      return runnerStatus(projectId);
    },
    { requires: PERMISSIONS.EXECUTION_REQUEST_READ }
  )
);
app.post(
  '/api/runner/claim',
  handle(
    req =>
      claimRunnerRequest({
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : null,
        clientDevice: {
          deviceFingerprint:
            typeof req.body?.deviceFingerprint === 'string' ? req.body.deviceFingerprint : null,
          deviceLabel: typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : null,
          devicePlatform:
            typeof req.body?.devicePlatform === 'string' ? req.body.devicePlatform : null
        }
      }),
    { mutates: true, requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM }
  )
);
app.post(
  '/api/runner/clear',
  handle(
    req =>
      clearRunnerRequests({
        objectiveId: typeof req.body?.objectiveId === 'string' ? req.body.objectiveId : null,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : null
      }),
    { mutates: true, requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM }
  )
);
app.post(
  '/api/runner/requests/:id/launching',
  handle(req => updateRunnerRequestStatus({ requestId: req.params.id, status: 'launching' }), {
    mutates: true,
    requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM
  })
);
app.post(
  '/api/runner/requests/:id/launched',
  handle(req => updateRunnerRequestStatus({ requestId: req.params.id, status: 'launched' }), {
    mutates: true,
    requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM
  })
);
app.post(
  '/api/runner/requests/:id/failed',
  handle(
    req =>
      updateRunnerRequestStatus({
        requestId: req.params.id,
        status: 'failed',
        error: typeof req.body?.error === 'string' ? req.body.error : null
      }),
    { mutates: true, requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM }
  )
);
app.post(
  '/api/runner/requests/:id/completed',
  handle(
    req =>
      completeRunnerMutationRequest({
        requestId: req.params.id,
        mutationResult: req.body?.mutationResult
      }),
    { mutates: true, requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM }
  )
);
app.post(
  '/api/missions/:id/branch-prepared',
  handle(
    req =>
      recordBranchPrepared({
        missionId: req.params.id,
        requestId: typeof req.body?.requestId === 'string' ? req.body.requestId : null,
        payload: req.body?.branchAutomation
      }),
    { mutates: true, requires: PERMISSIONS.EXECUTION_REQUEST_CLAIM }
  )
);
// On-demand branch mutations (merge with parent / push parent / publish).
// Available only when the webapp server is local and co-located with the linked
// checkout; hosted backends return LOCAL_FILESYSTEM_UNAVAILABLE.
app.post(
  '/api/missions/:id/branch/action',
  handle(req => performBranchAction(req.params.id, req.body ?? {}), { mutates: true })
);
// Available branches in the mission project's primary repo, for the branch selector.
// Hosted backends return metadata-only branch choices.
app.get(
  '/api/missions/:id/branches',
  handle(req => listMissionBranches(req.params.id))
);

// ---- Worktrees (Settings → Worktrees) ---------------------------------------
// Enumerate / purge Overlord-managed worktrees under ~/.ovld/worktrees. These are
// local-backend-only host-side git operations.
app.get(
  '/api/worktrees',
  handle(() => listWorktrees(), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/worktrees/remove',
  handle(req => removeWorktree(req.body ?? {}), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.post(
  '/api/worktrees/purge-merged',
  handle(req => purgeMergedWorktrees(req.body ?? {}), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);

// ---- Static SPA (Local/desktop only: `yarn build` then `yarn start`) -------
// Cloud/Postgres backends are API-only; Vercel serves the SPA.

if (resolveServeSpa({ dialect: DATABASE_DIALECT }) && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---- Error handler -------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, detail: err.detail, code: err.code });
    return;
  }
  // Service-layer validation (invalid session, no active objective, missing
  // rationale, …) carries its own HTTP status and machine-readable code.
  if (err instanceof ServiceError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {})
    });
    return;
  }
  const databaseError = apiErrorFromDatabaseError(err);
  if (databaseError) {
    res.status(databaseError.status).json({
      error: databaseError.message,
      detail: databaseError.detail
    });
    return;
  }

  // Unexpected failures — include the underlying message so CLI/UI surfaces can
  // show something actionable instead of a bare "Internal error".
  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('[webapp] request failed:', message);
  res.status(500).json({ error: message, detail: message });
});

// Boot the server. Wrapped in an async function (rather than a top-level await)
// so the server bundle can be emitted as CommonJS — top-level await is ESM-only,
// and a CJS bundle lets the many CommonJS dependencies (dotenv, express, the
// google-auth chain, …) use native `require` instead of esbuild's ESM shim.
async function start(): Promise<void> {
  await initDatabase();

  const bootWorkspaceId = getActiveWorkspaceIdOrNull();
  syncSqlStudioForWorkspace({
    enabled:
      DATABASE_DIALECT === 'sqlite' &&
      bootWorkspaceId &&
      (envSqlStudioEnabled ?? (await readSqlStudioEnabled({ workspaceId: bootWorkspaceId })))
        ? true
        : false
  });

  // Downstream forks inject their own automations via OVERLORD_AUTOMATIONS_MODULE
  // (custom-automation extension point); a no-op when the env var is unset.
  const externalAutomations = await loadExternalAutomations();
  if (externalAutomations.length > 0) {
    console.log(`[webapp] loaded external automations: ${externalAutomations.join(', ')}`);
  }

  realtime.start();
  webhookDispatcher.start();

  const server = app.listen(bindPort, bindHost, () => {
    const databaseLabel =
      DATABASE_DIALECT === 'postgres' ? 'postgres (DATABASE_URL)' : DATABASE_PATH;
    console.log(`[webapp] Overlord web server listening on ${bindHost}:${bindPort}`);
    console.log(
      bootWorkspaceId
        ? `[webapp] workspace: ${WORKSPACE.name} (${WORKSPACE.slug})`
        : '[webapp] no workspace yet — awaiting onboarding'
    );
    console.log(`[webapp] database: ${databaseLabel} (${DATABASE_DIALECT})`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[webapp] port ${bindPort} is already in use. Stop the other process (yarn stop) or change web_port in overlord.toml.`
      );
      process.exit(1);
    }
    throw error;
  });
}

void start();
