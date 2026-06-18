import { type Permission, PERMISSIONS } from '@overlord/auth';
import { loadExternalAutomations } from '@overlord/automations';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../cli/src/config.ts';
import { ServiceError } from '../../src/service/errors.ts';
import { loadRepoEnvFiles } from '../load-repo-env.ts';

import { authNodeHandler, requireAuthenticatedSession } from './auth.ts';
import { DATABASE_PATH, WORKSPACE } from './db.ts';
import { apiErrorFromDatabaseError } from './errors.ts';
import {
  getAgentCatalog,
  getLaunchPreference,
  getLaunchSettings,
  getObjectivePrompt,
  launchObjective,
  refreshAgentCatalog,
  updateAgentLaunchConfig,
  updateLaunchPreference,
  updateTerminalProfile
} from './launch.ts';
import { runProtocolSubcommand } from './protocol.ts';
import { requirePermission } from './rbac.ts';
import { realtime } from './realtime.ts';
import {
  ApiError,
  createObjective,
  createProject,
  createProjectResource,
  createProjectStatus,
  createProjectTag,
  createTicket,
  createUserToken,
  deleteObjective,
  deleteProject,
  deleteProjectResource,
  deleteProjectStatus,
  deleteProjectTag,
  deleteTicket,
  getProfile,
  getProject,
  getProjectRepository,
  getTicketDetail,
  listArtifacts,
  listObjectives,
  listProjectResources,
  listProjects,
  listProjectStatuses,
  listProjectTags,
  listTicketEvents,
  listTicketFileChanges,
  listTickets,
  listUserTokens,
  renameUserToken,
  reorderBoardColumn,
  reorderFutureObjectives,
  reorderProjectStatuses,
  revokeUserToken,
  searchTickets,
  updateObjective,
  updateProfile,
  updateProject,
  updateProjectResource,
  updateProjectStatus,
  updateProjectTag,
  updateTicket
} from './repository.ts';
import {
  claimRunnerRequest,
  clearRunnerRequests,
  runnerStatus,
  updateRunnerRequestStatus
} from './runner.ts';
import {
  getSqlStudioState,
  initSqlStudioManager,
  syncSqlStudioForWorkspace
} from './sql-studio-manager.ts';
import {
  deleteObjectiveAttachment,
  listObjectiveAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  resolveStoredObject,
  uploadObjectiveAttachment,
  uploadUserImage
} from './storage.ts';
import { readSqlStudioEnabled } from './workspace-settings.ts';
import {
  activateWorkspace,
  completeInitialSetup,
  createWorkspace,
  deleteWorkspace,
  listWorkspaceMembers,
  listWorkspaces,
  needsInitialSetup,
  updateWorkspace
} from './workspaces.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
// The built SPA. Defaults to `webapp/dist` next to this module (repo + server
// bundle layouts both resolve correctly); the packaged desktop overrides it with
// OVERLORD_WEBAPP_DIST so the embedded server serves the bundled static assets.
const distDir = process.env.OVERLORD_WEBAPP_DIST
  ? path.resolve(process.env.OVERLORD_WEBAPP_DIST)
  : path.resolve(here, '..', 'dist');

// Load packaged/default `.env` first. Source-server development also overlays
// `.env.local`, letting local ports/state differ from a packaged production
// instance without changing the production env file. Explicit shell exports win.
loadRepoEnvFiles([
  path.join(repoRoot, '.env'),
  ...(here === path.join(repoRoot, 'webapp', 'server') ? [path.join(repoRoot, '.env.local')] : [])
]);

const config = loadConfig();
const bindHost = process.env.OVERLORD_WEB_HOST ?? config.webHost;
const bindPort = Number(process.env.OVERLORD_WEB_PORT ?? config.webPort);
const sqlStudioHost = process.env.OVERLORD_SQL_STUDIO_HOST ?? config.sqlStudioHost;
const sqlStudioPort = Number(process.env.OVERLORD_SQL_STUDIO_PORT ?? config.sqlStudioPort);
const sqlStudioBinary = process.env.OVERLORD_SQL_STUDIO_BINARY ?? config.sqlStudioBinary;

initSqlStudioManager({
  binary: sqlStudioBinary,
  host: sqlStudioHost,
  port: sqlStudioPort,
  databasePath: DATABASE_PATH
});

const envSqlStudioEnabled =
  process.env.OVERLORD_SQL_STUDIO_ENABLED === 'true'
    ? true
    : process.env.OVERLORD_SQL_STUDIO_ENABLED === 'false'
      ? false
      : null;

syncSqlStudioForWorkspace({
  enabled: envSqlStudioEnabled ?? readSqlStudioEnabled({ workspaceId: WORKSPACE.id })
});

const app = express();
app.use(cors());
app.all('/api/auth/*', authNodeHandler);
app.use(express.json());

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
    try {
      if (options.requires) requirePermission(options.requires);
      const result = fn(req, res);
      if (options.mutates) realtime.pollNow();
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };
}

// ---- Meta / health -------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', requireAuthenticatedSession);

app.get(
  '/api/meta',
  handle(
    () => ({
      workspace: WORKSPACE,
      // True while the seeded first workspace is still unnamed; the web UI shows
      // the one-time initial setup step until `POST /api/setup` completes.
      needsSetup: needsInitialSetup(),
      databasePath: DATABASE_PATH,
      web: {
        host: bindHost,
        port: bindPort,
        url: `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`
      },
      sqlStudio: getSqlStudioState(),
      // Capabilities scoped to what this build supports. Launching queues
      // execution requests for a runner; execution-target management remains
      // CLI-only.
      capabilities: {
        projects: true,
        tickets: true,
        objectives: true,
        realtime: true,
        sqlStudio: getSqlStudioState().enabled,
        launchAgents: true,
        executionTargets: false
      }
    }),
    { requires: PERMISSIONS.WORKSPACE_READ }
  )
);

// ---- Initial instance setup ----------------------------------------------
//
// Names the seeded first workspace and sets the slug that prefixes ticket
// identifiers (`<slug>:<sequence>`). Changing the slug rewrites what `/api/meta`
// reports, so resync every subscriber.

app.post(
  '/api/setup',
  handle(
    req => {
      const result = completeInitialSetup(req.body);
      realtime.refreshAll();
      return result;
    },
    { requires: PERMISSIONS.WORKSPACE_UPDATE }
  )
);

// ---- Workspaces ----------------------------------------------------------
//
// One database can hold many workspaces and the operator can belong to several.
// Switching the active workspace changes what every other scoped query returns,
// so both routes force a coarse realtime refresh to resync all subscribers.

app.get(
  '/api/workspaces',
  handle(() => listWorkspaces(), { requires: PERMISSIONS.WORKSPACE_READ })
);
app.post(
  '/api/workspaces',
  handle(
    req => {
      const result = createWorkspace(req.body);
      realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_CREATE }
  )
);
app.patch(
  '/api/workspaces/:id',
  handle(
    req => {
      const result = updateWorkspace(req.params.id, req.body);
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
    req => {
      const result = deleteWorkspace(req.params.id);
      // Deleting may switch the active workspace; resync all subscribers.
      realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_DELETE }
  )
);
app.get(
  '/api/workspaces/:id/members',
  handle(req => listWorkspaceMembers(req.params.id), { requires: PERMISSIONS.WORKSPACE_READ })
);
app.post(
  '/api/workspaces/:id/activate',
  handle(
    req => {
      const result = activateWorkspace(req.params.id);
      realtime.refreshAll();
      return result;
    },
    { mutates: true, requires: PERMISSIONS.WORKSPACE_ACTIVATE }
  )
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
// Long-lived `USER_TOKEN` credentials owned by the local operator. Raw secrets
// are returned only from create; list/rename/revoke never expose them. Revoke
// is a soft state change (the row is retained for audit), not a deletion.

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

// ---- Uploads / storage ---------------------------------------------------
//
// The core upload service. `POST /api/uploads/:bucketKey` accepts raw image
// bytes (the SPA streams a single File as the request body), persists them to
// the bucket's storage backend, records provider-neutral metadata, and returns
// a descriptor whose `url` serves the bytes back. Only the `user-images` bucket
// is wired today; the surface is generic so other image buckets can reuse it.
//
// The body is parsed as a raw Buffer here (overriding the global JSON parser for
// this route) with the same ceiling the service enforces.

const rawImageBody = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });

app.post(
  '/api/uploads/:bucketKey',
  rawImageBody,
  handle(
    req => {
      if (req.params.bucketKey !== 'user-images') {
        throw new ApiError(404, `Uploads are not configured for bucket '${req.params.bucketKey}'`);
      }
      const headerName = req.header('x-upload-filename');
      const filename = headerName ? decodeURIComponent(headerName) : 'upload';
      return uploadUserImage({
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        filename,
        contentType: req.header('content-type') ?? ''
      });
    },
    { mutates: true, requires: PERMISSIONS.USER_IMAGE_SELF_CREATE }
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
    try {
      requirePermission(PERMISSIONS.PROJECT_READ);
      const resolved = resolveStoredObject(req.params.bucketKey, req.params.storageKey);
      res.type(resolved.contentType);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      if (resolved.forceDownload) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(resolved.filename)}"`
        );
      }
      res.sendFile(resolved.absolutePath);
    } catch (err) {
      next(err);
    }
  }
);

// ---- Realtime ------------------------------------------------------------

app.get('/api/stream', (req: Request, res: Response) => {
  try {
    requirePermission(PERMISSIONS.PROJECT_READ);
  } catch {
    res.status(403).json({ error: 'Permission denied: realtime stream' });
    return;
  }
  realtime.addClient(res);
  req.on('close', () => realtime.removeClient(res));
});

// ---- Projects ------------------------------------------------------------

app.get(
  '/api/projects',
  handle(() => listProjects(), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/projects',
  handle(req => createProject(req.body), { mutates: true, requires: PERMISSIONS.PROJECT_CREATE })
);
app.get(
  '/api/projects/:id',
  handle(req => getProject(req.params.id), { requires: PERMISSIONS.PROJECT_READ })
);
app.patch(
  '/api/projects/:id',
  handle(req => updateProject(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.delete(
  '/api/projects/:id',
  handle(req => deleteProject(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_DELETE
  })
);
app.get(
  '/api/projects/:id/statuses',
  handle(req => listProjectStatuses(req.params.id), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/projects/:id/statuses',
  handle(req => createProjectStatus(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.patch(
  '/api/projects/:id/statuses/reorder',
  handle(req => reorderProjectStatuses(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.patch(
  '/api/projects/:id/statuses/:statusId',
  handle(req => updateProjectStatus(req.params.id, req.params.statusId, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.delete(
  '/api/projects/:id/statuses/:statusId',
  handle(
    req => {
      deleteProjectStatus(req.params.id, req.params.statusId);
      return { ok: true as const };
    },
    { mutates: true, requires: PERMISSIONS.PROJECT_UPDATE }
  )
);
app.get(
  '/api/projects/:id/tags',
  handle(req => listProjectTags(req.params.id), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/projects/:id/tags',
  handle(req => createProjectTag(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.patch(
  '/api/projects/:id/tags/:tagId',
  handle(req => updateProjectTag(req.params.id, req.params.tagId, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.delete(
  '/api/projects/:id/tags/:tagId',
  handle(
    req => {
      deleteProjectTag(req.params.id, req.params.tagId);
      return { ok: true as const };
    },
    { mutates: true, requires: PERMISSIONS.PROJECT_UPDATE }
  )
);
app.get(
  '/api/projects/:id/resources',
  handle(req => listProjectResources(req.params.id), { requires: PERMISSIONS.PROJECT_READ })
);
app.post(
  '/api/projects/:id/resources',
  handle(req => createProjectResource(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.patch(
  '/api/projects/:id/resources/:resourceId',
  handle(req => updateProjectResource(req.params.id, req.params.resourceId, req.body), {
    mutates: true,
    requires: PERMISSIONS.PROJECT_UPDATE
  })
);
app.delete(
  '/api/projects/:id/resources/:resourceId',
  handle(
    req => {
      deleteProjectResource(req.params.id, req.params.resourceId);
      return { ok: true as const };
    },
    { mutates: true, requires: PERMISSIONS.PROJECT_UPDATE }
  )
);
app.get(
  '/api/projects/:id/repository',
  handle(
    req => {
      const executionTargetId =
        typeof req.query.executionTargetId === 'string' && req.query.executionTargetId.trim()
          ? req.query.executionTargetId.trim()
          : null;
      return getProjectRepository(req.params.id, executionTargetId);
    },
    { requires: PERMISSIONS.PROJECT_READ }
  )
);
app.get(
  '/api/projects/:id/tickets',
  handle(req => listTickets(req.params.id), { requires: PERMISSIONS.TICKET_READ })
);
app.patch(
  '/api/projects/:id/board/reorder',
  handle(req => reorderBoardColumn(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.TICKET_UPDATE
  })
);

// ---- Tickets -------------------------------------------------------------

app.get(
  '/api/tickets/search',
  handle(
    req => {
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
      return { tickets: searchTickets({ query, projectId, limit }) };
    },
    { requires: PERMISSIONS.TICKET_READ }
  )
);
app.post(
  '/api/tickets',
  handle(req => createTicket(req.body), { mutates: true, requires: PERMISSIONS.TICKET_CREATE })
);
app.get(
  '/api/tickets/:id',
  handle(req => getTicketDetail(req.params.id), { requires: PERMISSIONS.TICKET_READ })
);
app.patch(
  '/api/tickets/:id',
  handle(req => updateTicket(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.TICKET_UPDATE
  })
);
app.delete(
  '/api/tickets/:id',
  handle(req => deleteTicket(req.params.id), { mutates: true, requires: PERMISSIONS.TICKET_DELETE })
);
app.get(
  '/api/tickets/:id/objectives',
  handle(req => listObjectives(req.params.id), { requires: PERMISSIONS.OBJECTIVE_READ })
);
app.patch(
  '/api/tickets/:id/objectives/reorder',
  handle(req => reorderFutureObjectives(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.OBJECTIVE_UPDATE
  })
);
app.get(
  '/api/tickets/:id/events',
  handle(req => listTicketEvents(req.params.id), { requires: PERMISSIONS.EVENT_READ })
);
app.get(
  '/api/tickets/:id/artifacts',
  handle(req => listArtifacts(req.params.id), { requires: PERMISSIONS.ARTIFACT_READ })
);
app.get(
  '/api/tickets/:id/file-changes',
  handle(req => listTicketFileChanges(req.params.id), { requires: PERMISSIONS.TICKET_READ })
);

// ---- Objectives ----------------------------------------------------------

app.post(
  '/api/objectives',
  handle(req => createObjective(req.body), {
    mutates: true,
    requires: PERMISSIONS.OBJECTIVE_UPDATE
  })
);
app.patch(
  '/api/objectives/:id',
  handle(req => updateObjective(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.OBJECTIVE_UPDATE
  })
);
app.delete(
  '/api/objectives/:id',
  handle(req => deleteObjective(req.params.id), {
    mutates: true,
    requires: PERMISSIONS.OBJECTIVE_UPDATE
  })
);
app.post(
  '/api/objectives/:id/launch',
  handle(req => launchObjective(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.EXECUTION_REQUEST_CREATE
  })
);
app.get(
  '/api/objectives/:id/prompt',
  handle(req => getObjectivePrompt(req.params.id), { requires: PERMISSIONS.OBJECTIVE_READ })
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
app.get(
  '/api/projects/:id/launch-preference',
  handle(req => getLaunchPreference(req.params.id), { requires: PERMISSIONS.LAUNCH_READ })
);
app.put(
  '/api/projects/:id/launch-preference',
  handle(req => updateLaunchPreference(req.params.id, req.body), {
    mutates: true,
    requires: PERMISSIONS.LAUNCH_CONFIGURE
  })
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
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : null
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

// ---- Static SPA (production: `yarn build` then `yarn start`) ------------

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ---- Error handler -------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }
  // Service-layer validation (invalid session, no active objective, missing
  // rationale, …) carries its own HTTP status and machine-readable code.
  if (err instanceof ServiceError) {
    res.status(err.status).json({ error: err.message, code: err.code });
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
  // Downstream forks inject their own automations via OVERLORD_AUTOMATIONS_MODULE
  // (custom-automation extension point); a no-op when the env var is unset.
  const externalAutomations = await loadExternalAutomations();
  if (externalAutomations.length > 0) {
    console.log(`[webapp] loaded external automations: ${externalAutomations.join(', ')}`);
  }

  realtime.start();

  const server = app.listen(bindPort, bindHost, () => {
    console.log(
      `[webapp] Overlord web server listening on http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`
    );
    console.log(`[webapp] workspace: ${WORKSPACE.name} (${WORKSPACE.slug})`);
    console.log(`[webapp] database: ${DATABASE_PATH}`);
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
