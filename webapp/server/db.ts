import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChangeOperation } from '../shared/contract.ts';

// webapp/server/db.ts -> repo root is two levels up from server/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_DATABASE_PATH = '.overlord/Overlord.sqlite';

export function resolveDatabasePath(): string {
  const explicit = process.env.OVERLORD_SQLITE_PATH ?? DEFAULT_DATABASE_PATH;
  return path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit);
}

const databasePath = resolveDatabasePath();

if (!existsSync(databasePath)) {
  throw new Error(
    `Overlord SQLite database not found at ${databasePath}.\n` +
      'Run `yarn db:launch:local` from the repo root to create and migrate it first.'
  );
}

// Open the local Overlord database directly through better-sqlite3, exactly as
// the objective specifies. WAL mode lets the CLI write concurrently while the
// web server reads/writes; foreign_keys enforces the referential integrity the
// schema relies on.
export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export const DATABASE_PATH = databasePath;

export function nowIso(): string {
  // toISOString() always yields `YYYY-MM-DDTHH:MM:SS.mmmZ`, matching the
  // schema's timestamp CHECK constraint exactly.
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

// ---- Workspace / actor resolution ---------------------------------------

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
}

const workspace = db
  .prepare(
    `SELECT id, slug, name FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
  )
  .get() as WorkspaceRow | undefined;

if (!workspace) {
  throw new Error('No workspace found in the database. Initialise it with `yarn db:launch:local`.');
}

const actorRow = db
  .prepare(
    `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
  )
  .get(workspace.id) as { id: string } | undefined;

export const WORKSPACE = {
  id: workspace.id,
  slug: workspace.slug,
  name: workspace.name
};

/** The workspace user changes are attributed to (the local user for a local install). */
export const ACTOR_WORKSPACE_USER_ID: string | null = actorRow?.id ?? null;

// ---- entity_changes writer ----------------------------------------------

const insertChangeStmt = db.prepare(`
  INSERT INTO entity_changes (
    id, workspace_id, project_id, ticket_id, objective_id,
    entity_type, entity_id, operation, entity_revision,
    changed_fields_json, actor_workspace_user_id, actor_token_id, source, occurred_at
  ) VALUES (
    @id, @workspace_id, @project_id, @ticket_id, @objective_id,
    @entity_type, @entity_id, @operation, @entity_revision,
    @changed_fields_json, @actor_workspace_user_id, NULL, 'webapp', @occurred_at
  )
`);

export interface RecordChangeInput {
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  entityRevision?: number | null;
  projectId?: string | null;
  ticketId?: string | null;
  objectiveId?: string | null;
  changedFields?: string[];
}

/**
 * Append a row to the `entity_changes` feed. This must run inside the same
 * transaction as the domain mutation so the realtime feed never diverges from
 * the data. The realtime poller turns these rows into SSE deltas.
 */
export function recordChange(input: RecordChangeInput): void {
  insertChangeStmt.run({
    id: newId(),
    workspace_id: WORKSPACE.id,
    project_id: input.projectId ?? null,
    ticket_id: input.ticketId ?? null,
    objective_id: input.objectiveId ?? null,
    entity_type: input.entityType,
    entity_id: input.entityId,
    operation: input.operation,
    entity_revision: input.entityRevision ?? null,
    changed_fields_json: JSON.stringify(input.changedFields ?? []),
    actor_workspace_user_id: ACTOR_WORKSPACE_USER_ID,
    occurred_at: nowIso()
  });
}

export function currentMaxSeq(): number {
  const row = db.prepare(`SELECT MAX(seq) AS seq FROM entity_changes`).get() as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

export function dataVersion(): number {
  const row = db.pragma('data_version', { simple: true });
  return typeof row === 'number' ? row : Number(row);
}
