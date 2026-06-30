import type { AuthDomainDatabase } from '@overlord/auth';
import {
  applyHostedS3StorageBackend,
  createSqliteClient,
  type DatabaseClient,
  fixupLocalStoragePaths,
  migrateDatabase,
  migratePostgres,
  openDatabase,
  openDatabaseClient,
  resolveAdapter,
  type SqlDialect
} from '@overlord/database';
import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  applyDatabaseEnv,
  loadConfig,
  resolveDatabasePath as resolveConfiguredDatabasePath
} from '../../cli/src/config.ts';
import { loadEnvDefaults } from '../../cli/src/env.ts';
import { insertEntityChange } from '../../packages/core/service/change-feed.ts';
import type { ServiceContext } from '../../packages/core/service/context.ts';
import type { ClientDeviceIdentity } from '../../packages/core/service/device-identity.ts';
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
const adapter = resolveAdapter({ databasePath });

// On Local (SQLite) the file is opened synchronously at module load so first-run
// migrations seed an empty database before any request lands. On Postgres this
// stays null — there is no synchronous handle.
let sqliteDb: Database.Database | null = null;

if (adapter.type === 'sqlite') {
  // Open the local Overlord database through the database package so SQLite
  // connection pragmas stay centralized with the adapter runtime.
  sqliteDb = openDatabase({ databasePath });

  // First-run bootstrap: create the schema and seed the first workspace if the
  // database is empty; a no-op once migrated.
  migrateDatabase(sqliteDb);
  fixupLocalStoragePaths(sqliteDb, databasePath);
}

/**
 * The raw synchronous better-sqlite3 handle. **No production code path reads this
 * anymore** — the realtime `data_version` probe and the auth domain queries both
 * go through the async `DatabaseClient` below, which owns the handle. It remains
 * exported solely for the SQLite integration-test harness, which seeds fixtures
 * and asserts rows synchronously; those tests always run on SQLite, where this is
 * the live handle. On Postgres it is null (the cast keeps the test-only call sites
 * untyped-non-null); production never dereferences it, so the previous throwing
 * Postgres shim is no longer needed.
 */
export const db = sqliteDb as Database.Database;
export const DATABASE_DIALECT: SqlDialect = adapter.type;
export let databaseClient: DatabaseClient | null =
  sqliteDb === null ? null : createSqliteClient(sqliteDb);

let databaseInitPromise: Promise<DatabaseClient> | null = null;

export async function initDatabase(): Promise<DatabaseClient> {
  if (databaseClient) {
    await refreshActiveWorkspaceFromClient(databaseClient);
    return databaseClient;
  }
  if (!databaseInitPromise) {
    databaseInitPromise = (async () => {
      const client = await openDatabaseClient(adapter);
      if (client.dialect === 'postgres') {
        await migratePostgres(client);
        // Hosted-only, idempotent: point the seeded storage buckets at the S3
        // backend when the S3_* env vars are present. Local/SQLite installs keep
        // local_fs (this branch never runs for them). Credentials stay in env;
        // only non-secret provider metadata is written to settings_json.
        await applyHostedS3StorageBackend(client);
      }
      databaseClient = client;
      await refreshActiveWorkspaceFromClient(client);
      return client;
    })();
  }
  return databaseInitPromise;
}

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

function loadWorkspaceRowFromClient(
  client: DatabaseClient,
  id: string
): Promise<WorkspaceRow | undefined> {
  return client.get<WorkspaceRow>(
    `SELECT id, slug, name, kind, created_at FROM workspaces
       WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
}

async function oldestWorkspaceRowFromClient(
  client: DatabaseClient
): Promise<WorkspaceRow | undefined> {
  return client.get<WorkspaceRow>(
    `SELECT id, slug, name, kind, created_at FROM workspaces
       WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
  );
}

/** Resolve the workspace user that changes in `workspaceId` are attributed to. */
export async function resolveActorForWorkspace(
  workspaceId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  const row = await client.get<{ id: string }>(
    `SELECT id FROM workspace_users
       WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [workspaceId]
  );
  return row?.id ?? null;
}

export const resolveActorForWorkspaceAsync = resolveActorForWorkspace;

export let WORKSPACE: { id: string; slug: string; name: string; kind: string } = {
  id: 'pending-workspace',
  slug: 'pending',
  name: 'Pending Workspace',
  kind: 'user'
};

/** The workspace user changes are attributed to, once a local account exists. */
export let ACTOR_WORKSPACE_USER_ID: string | null = null;

export interface RequestContext {
  actorWorkspaceUserId: string | null;
  activeTokenId: string | null;
  activeTokenScopes: string[] | null;
  clientDevice: ClientDeviceIdentity | null;
}

function defaultRequestContext(): RequestContext {
  return {
    actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID,
    activeTokenId: ACTIVE_TOKEN_ID,
    activeTokenScopes: ACTIVE_TOKEN_SCOPES,
    clientDevice: null
  };
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export async function withRequestContextAsync<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(defaultRequestContext(), fn);
}

function requestContext(): RequestContext {
  const store = requestContextStorage.getStore();
  if (store) return store;
  return defaultRequestContext();
}

function mutateRequestContext(next: RequestContext): void {
  const store = requestContextStorage.getStore();
  if (store) {
    store.actorWorkspaceUserId = next.actorWorkspaceUserId;
    store.activeTokenId = next.activeTokenId;
    store.activeTokenScopes = next.activeTokenScopes;
    store.clientDevice = next.clientDevice;
    return;
  }
  ACTOR_WORKSPACE_USER_ID = next.actorWorkspaceUserId;
  ACTIVE_TOKEN_ID = next.activeTokenId;
  ACTIVE_TOKEN_SCOPES = next.activeTokenScopes;
}

export function getActorWorkspaceUserId(): string | null {
  return requestContext().actorWorkspaceUserId;
}

export function getActiveTokenId(): string | null {
  return requestContext().activeTokenId;
}

export function getActiveTokenScopes(): string[] | null {
  return requestContext().activeTokenScopes;
}

export function getClientDeviceIdentity(): ClientDeviceIdentity | null {
  return requestContext().clientDevice;
}

export function setClientDeviceIdentity(clientDevice: ClientDeviceIdentity | null): void {
  const current = requestContext();
  mutateRequestContext({
    actorWorkspaceUserId: current.actorWorkspaceUserId,
    activeTokenId: current.activeTokenId,
    activeTokenScopes: current.activeTokenScopes,
    clientDevice
  });
}

export function buildWebappServiceContext(
  client: DatabaseClient = requireDatabaseClient()
): ServiceContext {
  return {
    db: client,
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: getActorWorkspaceUserId(),
    source: 'webapp',
    clientDevice: getClientDeviceIdentity()
  };
}

/**
 * Switch the active workspace. Re-points the `WORKSPACE` and
 * `ACTOR_WORKSPACE_USER_ID` live bindings so subsequent reads/writes scope to
 * the new workspace. Returns the new workspace row, or `null` if `id` does not
 * resolve to an existing (non-deleted) workspace.
 */
export async function setActiveWorkspace(id: string): Promise<WorkspaceRow | null> {
  if (id === WORKSPACE.id) return (await loadWorkspaceRowAsync(id)) ?? null;
  const row = await loadWorkspaceRowAsync(id);
  if (!row) return null;
  WORKSPACE = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
  ACTOR_WORKSPACE_USER_ID = await resolveActorForWorkspace(row.id);
  return row;
}

async function loadWorkspaceRowAsync(
  id: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<WorkspaceRow | undefined> {
  return client.get<WorkspaceRow>(
    `SELECT id, slug, name, kind, created_at FROM workspaces
       WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
}

async function refreshActiveWorkspaceFromClient(client: DatabaseClient): Promise<void> {
  const row = await oldestWorkspaceRowFromClient(client);
  if (!row) {
    throw new Error('No workspace found in the database. Re-run migrations to seed it.');
  }
  WORKSPACE = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
  ACTOR_WORKSPACE_USER_ID = await resolveActorForWorkspace(row.id, client);
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
  mutateRequestContext({
    actorWorkspaceUserId: workspaceUserId,
    activeTokenId: null,
    activeTokenScopes: null,
    clientDevice: getClientDeviceIdentity()
  });
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
  mutateRequestContext({
    actorWorkspaceUserId: workspaceUserId,
    activeTokenId: tokenId,
    activeTokenScopes: scopeGrants && scopeGrants.length > 0 ? scopeGrants : null,
    clientDevice: getClientDeviceIdentity()
  });
}

/**
 * Re-read the active workspace row after it was mutated in place (e.g. a
 * rename) so the `WORKSPACE` live binding — and everything derived from it,
 * like `/api/meta` — reflects the new values.
 */
export async function reloadActiveWorkspace(): Promise<void> {
  const row = await loadWorkspaceRowAsync(WORKSPACE.id);
  if (row) WORKSPACE = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
}

export function requireDatabaseClient(): DatabaseClient {
  if (!databaseClient) {
    throw new Error(
      'Database has not been initialized. Call initDatabase() during server startup.'
    );
  }
  return databaseClient;
}

/** Test harness: point server modules at an already-migrated client. */
export async function bindDatabaseClient(client: DatabaseClient): Promise<void> {
  databaseClient = client;
  await refreshActiveWorkspaceFromClient(client);
}

/**
 * The handle the auth domain queries run against. The async `DatabaseClient`
 * speaks `?` placeholders on both SQLite and Postgres, so one handle serves both
 * editions — there is no longer a dialect branch or a raw synchronous handle here.
 */
export function authDomainDatabase(): AuthDomainDatabase {
  return requireDatabaseClient();
}

export function serviceDatabaseClient(): DatabaseClient {
  // The service layer is async on both dialects: always hand back the resolved
  // async DatabaseClient (a SqliteClient wrapping the better-sqlite3 handle on
  // Local), never the raw synchronous better-sqlite3 handle.
  return requireDatabaseClient();
}

// ---- entity_changes writer ----------------------------------------------

export interface RecordChangeInput {
  entityType: string;
  entityId: string;
  operation: ChangeOperation;
  entityRevision?: number | null;
  projectId?: string | null;
  missionId?: string | null;
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
export async function recordChange(
  input: RecordChangeInput,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  await insertEntityChange(client, {
    workspaceId: input.workspaceId ?? WORKSPACE.id,
    projectId: input.projectId,
    missionId: input.missionId,
    objectiveId: input.objectiveId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    entityRevision: input.entityRevision,
    changedFields: input.changedFields,
    actorWorkspaceUserId:
      input.actorWorkspaceUserId !== undefined
        ? input.actorWorkspaceUserId
        : getActorWorkspaceUserId(),
    actorTokenId: getActiveTokenId(),
    source: 'webapp'
  });
}

export async function currentMaxSeq(
  client: DatabaseClient = requireDatabaseClient()
): Promise<number> {
  const row = await client.get<{ seq: number | null }>(
    `SELECT MAX(seq) AS seq FROM entity_changes`
  );
  return row?.seq ?? 0;
}
