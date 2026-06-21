import { fixupLocalStoragePaths, migrateDatabase } from '@overlord/database';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  applyDatabaseEnv,
  loadConfig,
  resolveDatabasePath as resolveConfiguredDatabasePath
} from '../../cli/src/config.ts';
import { loadEnvDefaults } from '../../cli/src/env.ts';
import type { ChangeOperation } from '../shared/contract.ts';

import { ENV_PROFILE, REPO_ROOT } from './env-profile.ts';

loadEnvDefaults(REPO_ROOT, ENV_PROFILE);

export function resolveDatabasePath(): string {
  const explicit = process.env.OVERLORD_SQLITE_PATH;
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(REPO_ROOT, explicit);
  }
  const config = loadConfig(path.join(REPO_ROOT, 'overlord.toml'), ENV_PROFILE);
  // Bridge any admin-configured cloud DB so auth and the shared adapter agree.
  applyDatabaseEnv(config);
  return resolveConfiguredDatabasePath(config, REPO_ROOT);
}

const databasePath = resolveDatabasePath();

// Open the local Overlord database directly through better-sqlite3, exactly as
// the objective specifies. WAL mode lets the CLI write concurrently while the
// web server reads/writes; foreign_keys enforces the referential integrity the
// schema relies on. We create the parent directory first so a fresh
// app-data/global location (e.g. the packaged desktop's userData dir) works
// without any prior setup.
mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// First-run bootstrap: create the schema and seed the first workspace if the
// database is empty; a no-op once migrated. This is what makes `ovld serve` and
// the packaged desktop come up on a clean machine without `yarn start:local`.
// (Idempotent — checksums are verified against schema_migrations.)
migrateDatabase(db);

fixupLocalStoragePaths(db, databasePath);

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
//
// A single Overlord database can hold many workspaces, and the local operator
// can be a member of more than one. The web server tracks one *active*
// workspace at a time; every read/write below scopes to it. `WORKSPACE` and
// `ACTOR_WORKSPACE_USER_ID` are exported as live `let` bindings so switching the
// active workspace at runtime (see `setActiveWorkspace`) is observed by every
// module that imports them without any further wiring.

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  created_at: string;
}

function loadWorkspaceRow(id: string): WorkspaceRow | undefined {
  return db
    .prepare(
      `SELECT id, slug, name, kind, created_at FROM workspaces
         WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id) as WorkspaceRow | undefined;
}

function oldestWorkspaceRow(): WorkspaceRow | undefined {
  return db
    .prepare(
      `SELECT id, slug, name, kind, created_at FROM workspaces
         WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
    )
    .get() as WorkspaceRow | undefined;
}

/** Resolve the workspace user that changes in `workspaceId` are attributed to. */
export function resolveActorForWorkspace(workspaceId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM workspace_users
         WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`
    )
    .get(workspaceId) as { id: string } | undefined;
  return row?.id ?? null;
}

const initialWorkspace = oldestWorkspaceRow();

if (!initialWorkspace) {
  // Migrations seed the first workspace, so a freshly migrated database always
  // has one. Reaching here means the database predates the seed migration or
  // was tampered with — re-run migrations (`ovld serve` / `yarn start:local`).
  throw new Error('No workspace found in the database. Re-run migrations to seed it.');
}

export let WORKSPACE: { id: string; slug: string; name: string; kind: string } = {
  id: initialWorkspace.id,
  slug: initialWorkspace.slug,
  name: initialWorkspace.name,
  kind: initialWorkspace.kind
};

/** The workspace user changes are attributed to, once a local account exists. */
export let ACTOR_WORKSPACE_USER_ID: string | null = resolveActorForWorkspace(initialWorkspace.id);

/**
 * Switch the active workspace. Re-points the `WORKSPACE` and
 * `ACTOR_WORKSPACE_USER_ID` live bindings so subsequent reads/writes scope to
 * the new workspace. Returns the new workspace row, or `null` if `id` does not
 * resolve to an existing (non-deleted) workspace.
 */
export function setActiveWorkspace(id: string): WorkspaceRow | null {
  if (id === WORKSPACE.id) return loadWorkspaceRow(id) ?? null;
  const row = loadWorkspaceRow(id);
  if (!row) return null;
  WORKSPACE = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
  ACTOR_WORKSPACE_USER_ID = resolveActorForWorkspace(row.id);
  return row;
}

/**
 * Per-request token auth context. `ACTIVE_TOKEN_SCOPES` is the set of scope grant
 * patterns carried by the authenticating `USER_TOKEN` (`null` = session/loopback
 * auth or a `full` token, i.e. no token-level restriction). `ACTIVE_TOKEN_ID`
 * attributes mutations to the token in the change feed. Both are live `let`
 * bindings reset at the start of every authenticated request; the server handles
 * requests sequentially with synchronous better-sqlite3 handlers, so a per-request
 * global is safe and mirrors the existing `ACTOR_WORKSPACE_USER_ID` pattern.
 */
export let ACTIVE_TOKEN_SCOPES: string[] | null = null;
export let ACTIVE_TOKEN_ID: string | null = null;

/**
 * Point request attribution at the workspace user resolved from an authenticated
 * web session (or the loopback-trusted local operator). This auth method carries
 * no token-level restriction, so token scope/id are cleared.
 */
export function setActiveWorkspaceUser(workspaceUserId: string | null): void {
  ACTOR_WORKSPACE_USER_ID = workspaceUserId;
  ACTIVE_TOKEN_SCOPES = null;
  ACTIVE_TOKEN_ID = null;
}

/**
 * Point request attribution at the workspace user a `USER_TOKEN` authenticated as,
 * recording its scope grants (for the `requirePermission` gate) and id (for change
 * attribution). `scopeGrants === null` means a `full` token (no restriction).
 */
export function setActiveTokenAuth({
  workspaceUserId,
  tokenId,
  scopeGrants
}: {
  workspaceUserId: string | null;
  tokenId: string | null;
  scopeGrants: string[] | null;
}): void {
  ACTOR_WORKSPACE_USER_ID = workspaceUserId;
  ACTIVE_TOKEN_ID = tokenId;
  ACTIVE_TOKEN_SCOPES = scopeGrants && scopeGrants.length > 0 ? scopeGrants : null;
}

/**
 * Re-read the active workspace row after it was mutated in place (e.g. a
 * rename) so the `WORKSPACE` live binding — and everything derived from it,
 * like `/api/meta` — reflects the new values.
 */
export function reloadActiveWorkspace(): void {
  const row = loadWorkspaceRow(WORKSPACE.id);
  if (row) WORKSPACE = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
}

// ---- entity_changes writer ----------------------------------------------

const insertChangeStmt = db.prepare(`
  INSERT INTO entity_changes (
    id, workspace_id, project_id, ticket_id, objective_id,
    entity_type, entity_id, operation, entity_revision,
    changed_fields_json, actor_workspace_user_id, actor_token_id, source, occurred_at
  ) VALUES (
    @id, @workspace_id, @project_id, @ticket_id, @objective_id,
    @entity_type, @entity_id, @operation, @entity_revision,
    @changed_fields_json, @actor_workspace_user_id, @actor_token_id, 'webapp', @occurred_at
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
  /** Override the workspace the change is attributed to (defaults to the active one). */
  workspaceId?: string | null;
  /** Override the actor the change is attributed to (defaults to the active one). */
  actorWorkspaceUserId?: string | null;
}

/**
 * Append a row to the `entity_changes` feed. This must run inside the same
 * transaction as the domain mutation so the realtime feed never diverges from
 * the data. The realtime poller turns these rows into SSE deltas.
 */
export function recordChange(input: RecordChangeInput): void {
  insertChangeStmt.run({
    id: newId(),
    workspace_id: input.workspaceId ?? WORKSPACE.id,
    project_id: input.projectId ?? null,
    ticket_id: input.ticketId ?? null,
    objective_id: input.objectiveId ?? null,
    entity_type: input.entityType,
    entity_id: input.entityId,
    operation: input.operation,
    entity_revision: input.entityRevision ?? null,
    changed_fields_json: JSON.stringify(input.changedFields ?? []),
    actor_workspace_user_id:
      input.actorWorkspaceUserId !== undefined
        ? input.actorWorkspaceUserId
        : ACTOR_WORKSPACE_USER_ID,
    actor_token_id: ACTIVE_TOKEN_ID,
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
