import cors from 'cors';
import { config as loadEnv } from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../cli/src/config.ts';

import { DATABASE_PATH, WORKSPACE } from './db.ts';
import {
  getAgentCatalog,
  getLaunchPreference,
  getLaunchSettings,
  getObjectivePrompt,
  launchObjective,
  refreshAgentCatalog,
  updateAgentLaunchConfig,
  updateLaunchPreference
} from './launch.ts';
import { realtime } from './realtime.ts';
import {
  ApiError,
  createObjective,
  createProject,
  createProjectStatus,
  createTicket,
  createUserToken,
  deleteObjective,
  deleteProject,
  deleteProjectStatus,
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
  updateProjectStatus,
  updateTicket
} from './repository.ts';
import { startSqlStudio } from './sql-studio.ts';
import {
  deleteObjectiveAttachment,
  listObjectiveAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_BYTES,
  resolveStoredObject,
  uploadObjectiveAttachment,
  uploadUserImage
} from './storage.ts';
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
const distDir = path.resolve(here, '..', 'dist');

loadEnv({ path: path.join(repoRoot, '.env') });

const config = loadConfig();
const bindHost = process.env.OVERLORD_WEB_HOST ?? config.webHost;
const bindPort = Number(process.env.OVERLORD_WEB_PORT ?? config.webPort);
const sqlStudioHost = process.env.OVERLORD_SQL_STUDIO_HOST ?? config.sqlStudioHost;
const sqlStudioPort = Number(process.env.OVERLORD_SQL_STUDIO_PORT ?? config.sqlStudioPort);
const sqlStudio = startSqlStudio({
  enabled: process.env.OVERLORD_SQL_STUDIO_ENABLED
    ? process.env.OVERLORD_SQL_STUDIO_ENABLED === 'true'
    : config.sqlStudioEnabled,
  binary: process.env.OVERLORD_SQL_STUDIO_BINARY ?? config.sqlStudioBinary,
  host: sqlStudioHost,
  port: sqlStudioPort,
  databasePath: DATABASE_PATH
});

const app = express();
app.use(cors());
app.use(express.json());

// Small wrapper so handlers can throw ApiError / Error and get a clean response.
// Also triggers an immediate realtime poll after mutations for snappy echoes.
function handle(fn: (req: Request, res: Response) => unknown, options: { mutates?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
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

app.get(
  '/api/meta',
  handle(() => ({
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
    sqlStudio: {
      enabled: Boolean(sqlStudio.url),
      url: sqlStudio.url
    },
    // Capabilities scoped to what this build supports. Launching queues
    // execution requests for a runner; execution-target management remains
    // CLI-only.
    capabilities: {
      projects: true,
      tickets: true,
      objectives: true,
      realtime: true,
      sqlStudio: Boolean(sqlStudio.url),
      launchAgents: true,
      executionTargets: false
    }
  }))
);

// ---- Initial instance setup ----------------------------------------------
//
// Names the seeded first workspace and sets the slug that prefixes ticket
// identifiers (`<slug>:<sequence>`). Changing the slug rewrites what `/api/meta`
// reports, so resync every subscriber.

app.post(
  '/api/setup',
  handle(req => {
    const result = completeInitialSetup(req.body);
    realtime.refreshAll();
    return result;
  })
);

// ---- Workspaces ----------------------------------------------------------
//
// One database can hold many workspaces and the operator can belong to several.
// Switching the active workspace changes what every other scoped query returns,
// so both routes force a coarse realtime refresh to resync all subscribers.

app.get(
  '/api/workspaces',
  handle(() => listWorkspaces())
);
app.post(
  '/api/workspaces',
  handle(req => {
    const result = createWorkspace(req.body);
    realtime.refreshAll();
    return result;
  })
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
    { mutates: true }
  )
);
app.delete(
  '/api/workspaces/:id',
  handle(req => {
    const result = deleteWorkspace(req.params.id);
    // Deleting may switch the active workspace; resync all subscribers.
    realtime.refreshAll();
    return result;
  })
);
app.get(
  '/api/workspaces/:id/members',
  handle(req => listWorkspaceMembers(req.params.id))
);
app.post(
  '/api/workspaces/:id/activate',
  handle(req => {
    const result = activateWorkspace(req.params.id);
    realtime.refreshAll();
    return result;
  })
);

// ---- Profile -------------------------------------------------------------
//
// The local operator's user-account profile. This build runs as a single
// trusted local user, so the profile maps directly to that operator's row in
// the `users` table.

app.get(
  '/api/profile',
  handle(() => getProfile())
);
app.patch(
  '/api/profile',
  handle(req => updateProfile(req.body), { mutates: true })
);

// ---- User tokens ---------------------------------------------------------
//
// Long-lived `USER_TOKEN` credentials owned by the local operator. Raw secrets
// are returned only from create; list/rename/revoke never expose them. Revoke
// is a soft state change (the row is retained for audit), not a deletion.

app.get(
  '/api/user-tokens',
  handle(() => listUserTokens())
);
app.post(
  '/api/user-tokens',
  handle(req => createUserToken(req.body), { mutates: true })
);
app.patch(
  '/api/user-tokens/:id',
  handle(req => renameUserToken(req.params.id, req.body), { mutates: true })
);
app.post(
  '/api/user-tokens/:id/revoke',
  handle(req => revokeUserToken(req.params.id), { mutates: true })
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
    try {
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
  realtime.addClient(res);
  req.on('close', () => realtime.removeClient(res));
});

// ---- Projects ------------------------------------------------------------

app.get(
  '/api/projects',
  handle(() => listProjects())
);
app.post(
  '/api/projects',
  handle(req => createProject(req.body), { mutates: true })
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
  '/api/projects/:id/statuses',
  handle(req => listProjectStatuses(req.params.id))
);
app.post(
  '/api/projects/:id/statuses',
  handle(req => createProjectStatus(req.params.id, req.body), { mutates: true })
);
app.patch(
  '/api/projects/:id/statuses/reorder',
  handle(req => reorderProjectStatuses(req.params.id, req.body), { mutates: true })
);
app.patch(
  '/api/projects/:id/statuses/:statusId',
  handle(req => updateProjectStatus(req.params.id, req.params.statusId, req.body), {
    mutates: true
  })
);
app.delete(
  '/api/projects/:id/statuses/:statusId',
  handle(
    req => {
      deleteProjectStatus(req.params.id, req.params.statusId);
      return { ok: true as const };
    },
    { mutates: true }
  )
);
app.get(
  '/api/projects/:id/resources',
  handle(req => listProjectResources(req.params.id))
);
app.get(
  '/api/projects/:id/repository',
  handle(req => {
    const executionTargetId =
      typeof req.query.executionTargetId === 'string' && req.query.executionTargetId.trim()
        ? req.query.executionTargetId.trim()
        : null;
    return getProjectRepository(req.params.id, executionTargetId);
  })
);
app.get(
  '/api/projects/:id/tickets',
  handle(req => listTickets(req.params.id))
);
app.patch(
  '/api/projects/:id/board/reorder',
  handle(req => reorderBoardColumn(req.params.id, req.body), { mutates: true })
);

// ---- Tickets -------------------------------------------------------------

app.get(
  '/api/tickets/search',
  handle(req => {
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
  })
);
app.post(
  '/api/tickets',
  handle(req => createTicket(req.body), { mutates: true })
);
app.get(
  '/api/tickets/:id',
  handle(req => getTicketDetail(req.params.id))
);
app.patch(
  '/api/tickets/:id',
  handle(req => updateTicket(req.params.id, req.body), { mutates: true })
);
app.delete(
  '/api/tickets/:id',
  handle(req => deleteTicket(req.params.id), { mutates: true })
);
app.get(
  '/api/tickets/:id/objectives',
  handle(req => listObjectives(req.params.id))
);
app.patch(
  '/api/tickets/:id/objectives/reorder',
  handle(req => reorderFutureObjectives(req.params.id, req.body), { mutates: true })
);
app.get(
  '/api/tickets/:id/events',
  handle(req => listTicketEvents(req.params.id))
);
app.get(
  '/api/tickets/:id/artifacts',
  handle(req => listArtifacts(req.params.id))
);
app.get(
  '/api/tickets/:id/file-changes',
  handle(req => listTicketFileChanges(req.params.id))
);

// ---- Objectives ----------------------------------------------------------

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
  handle(req => listObjectiveAttachments(req.params.id))
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
    { mutates: true }
  )
);
app.delete(
  '/api/objectives/:id/attachments/:attachmentId',
  handle(req => deleteObjectiveAttachment(req.params.id, req.params.attachmentId), {
    mutates: true
  })
);

// ---- Agent catalog and launch configuration -------------------------------

app.get(
  '/api/agent-catalog',
  handle(() => getAgentCatalog())
);
app.post(
  '/api/agent-catalog/refresh',
  handle(() => refreshAgentCatalog(), { mutates: true })
);
app.get(
  '/api/launch-settings',
  handle(() => getLaunchSettings())
);
app.patch(
  '/api/launch-settings/agents/:agentKey',
  handle(req => updateAgentLaunchConfig(req.params.agentKey, req.body), { mutates: true })
);
app.get(
  '/api/projects/:id/launch-preference',
  handle(req => getLaunchPreference(req.params.id))
);
app.put(
  '/api/projects/:id/launch-preference',
  handle(req => updateLaunchPreference(req.params.id, req.body), { mutates: true })
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
  // SQLite constraint failures and the like.
  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('[webapp] request failed:', message);
  res.status(500).json({ error: 'Internal error', detail: message });
});

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
