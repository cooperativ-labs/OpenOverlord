import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import { DATABASE_PATH, WORKSPACE } from "./db.ts";
import { realtime } from "./realtime.ts";
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
  listProjects,
  listProjectResources,
  listProjectStatuses,
  listTickets,
  reorderBoardColumn,
  updateObjective,
  updateProject,
  updateTicket,
} from "./repository.ts";

const PORT = Number(process.env.OVERLORD_WEB_PORT ?? 8787);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distDir = path.resolve(here, "..", "dist");

loadEnv({ path: path.join(repoRoot, ".env") });

const app = express();
app.use(cors());
app.use(express.json());

// Small wrapper so handlers can throw ApiError / Error and get a clean response.
// Also triggers an immediate realtime poll after mutations for snappy echoes.
function handle(
  fn: (req: Request, res: Response) => unknown,
  options: { mutates?: boolean } = {},
) {
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

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get(
  "/api/meta",
  handle(() => ({
    workspace: WORKSPACE,
    databasePath: DATABASE_PATH,
    // Capabilities scoped to what this build supports. Execution-target config
    // and click-to-launch are deliberately CLI-only for now.
    capabilities: {
      projects: true,
      tickets: true,
      objectives: true,
      realtime: true,
      launchAgents: false,
      executionTargets: false,
    },
  })),
);

// ---- Realtime ------------------------------------------------------------

app.get("/api/stream", (req: Request, res: Response) => {
  realtime.addClient(res);
  req.on("close", () => realtime.removeClient(res));
});

// ---- Projects ------------------------------------------------------------

app.get("/api/projects", handle(() => listProjects()));
app.post("/api/projects", handle((req) => createProject(req.body), { mutates: true }));
app.get("/api/projects/:id", handle((req) => getProject(req.params.id)));
app.patch(
  "/api/projects/:id",
  handle((req) => updateProject(req.params.id, req.body), { mutates: true }),
);
app.get("/api/projects/:id/statuses", handle((req) => listProjectStatuses(req.params.id)));
app.get("/api/projects/:id/resources", handle((req) => listProjectResources(req.params.id)));
app.get(
  "/api/projects/:id/repository",
  handle((req) => {
    const executionTargetId =
      typeof req.query.executionTargetId === "string" && req.query.executionTargetId.trim()
        ? req.query.executionTargetId.trim()
        : null;
    return getProjectRepository(req.params.id, executionTargetId);
  }),
);
app.get("/api/projects/:id/tickets", handle((req) => listTickets(req.params.id)));
app.patch(
  "/api/projects/:id/board/reorder",
  handle((req) => reorderBoardColumn(req.params.id, req.body), { mutates: true }),
);

// ---- Tickets -------------------------------------------------------------

app.post("/api/tickets", handle((req) => createTicket(req.body), { mutates: true }));
app.get("/api/tickets/:id", handle((req) => getTicketDetail(req.params.id)));
app.patch(
  "/api/tickets/:id",
  handle((req) => updateTicket(req.params.id, req.body), { mutates: true }),
);
app.delete("/api/tickets/:id", handle((req) => deleteTicket(req.params.id), { mutates: true }));
app.get("/api/tickets/:id/objectives", handle((req) => listObjectives(req.params.id)));

// ---- Objectives ----------------------------------------------------------

app.post("/api/objectives", handle((req) => createObjective(req.body), { mutates: true }));
app.patch(
  "/api/objectives/:id",
  handle((req) => updateObjective(req.params.id, req.body), { mutates: true }),
);
app.delete(
  "/api/objectives/:id",
  handle((req) => deleteObjective(req.params.id), { mutates: true }),
);

// ---- Static SPA (production: `yarn build` then `yarn start`) ------------

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// ---- Error handler -------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }
  // SQLite constraint failures and the like.
  const message = err instanceof Error ? err.message : "Internal error";
  console.error("[webapp] request failed:", message);
  res.status(500).json({ error: "Internal error", detail: message });
});

realtime.start();

app.listen(PORT, () => {
  console.log(`[webapp] Overlord web server listening on http://localhost:${PORT}`);
  console.log(`[webapp] workspace: ${WORKSPACE.name} (${WORKSPACE.slug})`);
  console.log(`[webapp] database: ${DATABASE_PATH}`);
});
