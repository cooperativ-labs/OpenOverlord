import cors from 'cors';
import { config as loadEnv } from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveProjectRoot } from '../../cli/src/config.ts';

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
  createTicket,
  deleteObjective,
  deleteTicket,
  getProject,
  getProjectRepository,
  getTicketDetail,
  listObjectives,
  listProjectResources,
  listProjects,
  listProjectStatuses,
  listTicketEvents,
  listTickets,
  reorderBoardColumn,
  reorderFutureObjectives,
  updateObjective,
  updateProject,
  updateTicket
} from './repository.ts';
import { getSqliteTableData, listSqliteTables, runSqliteQuery } from './sqlite-browser.ts';
import { activateWorkspace, createWorkspace, listWorkspaces } from './workspaces.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distDir = path.resolve(here, '..', 'dist');

loadEnv({ path: path.join(repoRoot, '.env') });

const config = loadConfig();
const bindHost = process.env.OVERLORD_WEB_HOST ?? config.webHost;
const bindPort = Number(process.env.OVERLORD_WEB_PORT ?? config.webPort);
const projectRoot = resolveProjectRoot(repoRoot);

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
    databasePath: DATABASE_PATH,
    web: {
      host: bindHost,
      port: bindPort,
      url: `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`
    },
    // Capabilities scoped to what this build supports. Launching queues
    // execution requests for a runner; execution-target management remains
    // CLI-only.
    capabilities: {
      projects: true,
      tickets: true,
      objectives: true,
      realtime: true,
      sqliteBrowser: true,
      launchAgents: true,
      executionTargets: false
    }
  }))
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
app.post(
  '/api/workspaces/:id/activate',
  handle(req => {
    const result = activateWorkspace(req.params.id);
    realtime.refreshAll();
    return result;
  })
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
app.get(
  '/api/projects/:id/statuses',
  handle(req => listProjectStatuses(req.params.id))
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

// ---- SQLite browser ------------------------------------------------------

app.get(
  '/api/sqlite-browser/tables',
  handle(() => ({
    databasePath: DATABASE_PATH,
    workspaceRoot: projectRoot,
    tables: listSqliteTables()
  }))
);

app.get(
  '/api/sqlite-browser/tables/:tableName',
  handle(req =>
    getSqliteTableData({
      tableName: req.params.tableName,
      limit: req.query.limit,
      offset: req.query.offset
    })
  )
);

app.post(
  '/api/sqlite-browser/query',
  handle(req => runSqliteQuery(String(req.body?.sql ?? '')))
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

app.listen(bindPort, bindHost, () => {
  console.log(
    `[webapp] Overlord web server listening on http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${bindPort}`
  );
  console.log(`[webapp] workspace: ${WORKSPACE.name} (${WORKSPACE.slug})`);
  console.log(`[webapp] database: ${DATABASE_PATH}`);
});
