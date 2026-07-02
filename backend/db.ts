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
} from '../cli/src/config.ts';
import { loadEnvDefaults } from '../cli/src/env.ts';
import { insertEntityChange } from '../packages/core/service/change-feed.ts';
import type { ServiceContext } from '../packages/core/service/context.ts';
import type { ClientDeviceIdentity } from '../packages/core/service/device-identity.ts';
import type { ChangeOperation } from '../webapp/shared/contract.ts';

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
// A single Overlord database can hold many workspaces, and any number of
// tenants/profiles can be members of one. Each authenticated web request
// tracks its own *active* workspace via `AsyncLocalStorage`
// (`requestContextStorage` below); every read/write below scopes to that
// request-local value through `WORKSPACE`/`getActiveWorkspaceId()`. Only code
// running with no request context (bootstrap, the loopback CLI surface,
// tests) reads/writes the process-wide `defaultWorkspace`/
// `ACTOR_WORKSPACE_USER_ID` fallback `let` bindings — no per-request switch
// (see `setActiveWorkspace`) may leak into them.

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

/**
 * The canonical "is this profile an active member of this workspace" lookup:
 * the profile's oldest active `workspace_users` row in `workspaceId`, or
 * `null`. Membership rows are not tombstoned when their workspace is
 * soft-deleted, so this joins live workspaces — a membership in a deleted
 * workspace is not a membership. Every membership/authorization check that
 * starts from a profile (auth resolution, workspace guards, actor
 * attribution) goes through this one query so the definition of "active
 * membership" cannot drift.
 */
export async function findActiveMembershipId(
  workspaceId: string,
  profileId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  const row = await client.get<{ id: string }>(
    `SELECT wu.id FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id AND w.deleted_at IS NULL
      WHERE wu.workspace_id = ? AND wu.profile_id = ?
        AND wu.status = 'active' AND wu.deleted_at IS NULL
      ORDER BY wu.created_at ASC LIMIT 1`,
    [workspaceId, profileId]
  );
  return row?.id ?? null;
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

/**
 * Resolve the workspace_user row the *current request's authenticated caller*
 * owns in `workspaceId` — their own membership, not the workspace's oldest
 * member. Returns `null` when there is no request-scoped caller to attribute to
 * (the process-default/loopback path) or when the caller has no active
 * membership in the target workspace. Used by `setActiveWorkspace` so a
 * request-scoped switch never clobbers the acting user's attribution with an
 * oldest-member heuristic (e.g. an invitee accepting into a workspace whose
 * oldest member is someone else).
 */
async function resolveRequestActorForWorkspace(
  workspaceId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  const context = requestContextStorage.getStore();
  if (!context) return null;

  // Prefer the profile the request authenticated as; fall back to the profile
  // behind the currently-attributed workspace_user (a different workspace's
  // membership row) so token/session auth that only set the actor still resolves.
  let profileId = context.activeProfileId;
  if (!profileId && context.actorWorkspaceUserId) {
    const actorRow = await client.get<{ profile_id: string }>(
      `SELECT profile_id FROM workspace_users WHERE id = ?`,
      [context.actorWorkspaceUserId]
    );
    profileId = actorRow?.profile_id ?? null;
  }
  if (!profileId) return null;

  return findActiveMembershipId(workspaceId, profileId, client);
}

export interface ActiveWorkspace {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

/**
 * The process-wide fallback workspace: the value used for code that runs
 * outside any per-request context (server boot logging, the CLI/loopback
 * surface, background scripts, tests that never call `withRequestContextAsync`).
 * Every *authenticated web request* overrides this with the caller's own
 * resolved workspace via `setActiveWorkspaceContext` — see
 * `requireAuthenticatedSession` (`backend/auth.ts`) — so this default is never
 * consulted for a browser session's tenant-scoped reads. Only
 * `refreshActiveWorkspaceFromClient`/`bindDatabaseClient` (bootstrap/test
 * harness) and `mutateRequestContext`'s no-request-context fallback write to
 * this binding; a request-scoped `setActiveWorkspace` call (from
 * `backend/workspaces.ts`) never does, so one tenant's workspace switch can
 * never leak into another request's or the loopback surface's default.
 */
let defaultWorkspace: ActiveWorkspace = {
  id: 'pending-workspace',
  slug: 'pending',
  name: 'Pending Workspace',
  kind: 'user'
};

/** The workspace user changes are attributed to, once a local account exists. */
export let ACTOR_WORKSPACE_USER_ID: string | null = null;

export interface RequestContext {
  activeProfileId: string | null;
  actorWorkspaceUserId: string | null;
  activeTokenId: string | null;
  activeTokenScopes: string[] | null;
  clientDevice: ClientDeviceIdentity | null;
  /**
   * The tenant this request is scoped to. `null` means the authenticated
   * caller has no active workspace membership — reads/writes that depend on
   * `getActiveWorkspaceId()` must not run in that state (see
   * `getActiveWorkspace()` below), so every permission-gated route rejects it
   * before ever reaching a handler.
   */
  activeWorkspace: ActiveWorkspace | null;
}

function defaultRequestContext(): RequestContext {
  return {
    activeProfileId: null,
    actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID,
    activeTokenId: ACTIVE_TOKEN_ID,
    activeTokenScopes: ACTIVE_TOKEN_SCOPES,
    clientDevice: null,
    activeWorkspace: defaultWorkspace
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
    store.activeProfileId = next.activeProfileId;
    store.activeTokenId = next.activeTokenId;
    store.activeTokenScopes = next.activeTokenScopes;
    store.clientDevice = next.clientDevice;
    store.activeWorkspace = next.activeWorkspace;
    return;
  }
  ACTOR_WORKSPACE_USER_ID = next.actorWorkspaceUserId;
  ACTIVE_TOKEN_ID = next.activeTokenId;
  ACTIVE_TOKEN_SCOPES = next.activeTokenScopes;
  // `activeWorkspace` has no legacy module-global fallback to write through to:
  // `defaultWorkspace` is maintained solely by `refreshActiveWorkspaceFromClient`/
  // `bindDatabaseClient`, and this branch only runs when a setter is invoked
  // outside `withRequestContextAsync` (test helpers), which never target it.
}

export function getActiveProfileId(): string | null {
  return requestContext().activeProfileId;
}

export function setActiveProfileId(profileId: string | null): void {
  mutateRequestContext({ ...requestContext(), activeProfileId: profileId });
}

export function getActorWorkspaceUserId(): string | null {
  return requestContext().actorWorkspaceUserId;
}

/**
 * The tenant scoping this request. Throws if the authenticated caller has no
 * active workspace membership — every query that scopes by workspace must not
 * silently run against some other tenant's data (or the bootstrap default) in
 * that state. `requirePermission`/`actorCan` already reject a null actor before
 * any handler runs, so this only throws for routes that (incorrectly) skip
 * that gate; failing loudly beats leaking cross-tenant.
 */
export function getActiveWorkspace(): ActiveWorkspace {
  const workspace = requestContext().activeWorkspace;
  if (workspace === null) {
    throw new Error(
      'No active workspace for this request: the authenticated user has no active workspace membership.'
    );
  }
  return workspace;
}

export function getActiveWorkspaceId(): string {
  return getActiveWorkspace().id;
}

/**
 * Non-throwing variant for call sites that must run *before* it's known
 * whether the request has a resolved workspace at all — namely `rbac.ts`'s
 * `workspaceId = getActiveWorkspaceIdOrNull()` defaults. Default parameter
 * expressions evaluate unconditionally when the argument is omitted, even
 * though `actorCan`/`loadActorRoles` short-circuit to "no roles" before ever
 * using `workspaceId` when the actor is null — so that default must not throw,
 * or a no-membership request would 500 instead of the intended clean 403.
 */
export function getActiveWorkspaceIdOrNull(): string | null {
  return requestContext().activeWorkspace?.id ?? null;
}

/** Point the current request's tenant scoping at `workspace` (or `null` for no active membership). */
export function setActiveWorkspaceContext(workspace: ActiveWorkspace | null): void {
  mutateRequestContext({ ...requestContext(), activeWorkspace: workspace });
}

/**
 * Back-compat read-only view of the active workspace for call sites not yet
 * migrated to `getActiveWorkspaceId()`/`getActiveWorkspace()`. Each accessor
 * re-reads the current request's tenant scoping live (never a snapshot from
 * import time), so it is safe for any per-request code path to keep reading
 * `WORKSPACE.id`/`.slug`/`.name`/`.kind`.
 */
export const WORKSPACE: ActiveWorkspace = {
  get id() {
    return getActiveWorkspaceId();
  },
  get slug() {
    return getActiveWorkspace().slug;
  },
  get name() {
    return getActiveWorkspace().name;
  },
  get kind() {
    return getActiveWorkspace().kind;
  }
};

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
  mutateRequestContext({ ...requestContext(), clientDevice });
}

export function buildWebappServiceContext(
  client: DatabaseClient = requireDatabaseClient()
): ServiceContext {
  const workspace = getActiveWorkspace();
  return {
    db: client,
    workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
    actorWorkspaceUserId: getActorWorkspaceUserId(),
    source: 'webapp',
    clientDevice: getClientDeviceIdentity()
  };
}

/**
 * Set the process-wide fallback workspace/actor pair directly. This — plus
 * `refreshActiveWorkspaceFromClient`/`bindDatabaseClient` at bootstrap — is the
 * *only* writer of `defaultWorkspace`/`ACTOR_WORKSPACE_USER_ID`. It is not
 * exported: the sole caller is `setActiveWorkspace`'s no-request-context
 * branch below (the single-operator/loopback/bootstrap/test path). No
 * request-scoped call site may reach this — an authenticated multi-user
 * request always has a request context, so it always takes the other branch.
 */
function setProcessDefaultWorkspace(
  workspace: ActiveWorkspace,
  actorWorkspaceUserId: string | null
): void {
  defaultWorkspace = workspace;
  ACTOR_WORKSPACE_USER_ID = actorWorkspaceUserId;
}

/**
 * Switch the active workspace scoped to the *caller's own context*.
 *
 * - **Request-scoped** (called from inside a request — every authenticated
 *   `/api/*` handler runs inside `withRequestContextAsync`, so this covers
 *   `createWorkspace`/`acceptWorkspaceInvitation`/`switchWorkspace`/etc. in
 *   `backend/workspaces.ts`): mutates *only* that request's own tenant scoping
 *   via `mutateRequestContext`, and attributes subsequent changes to the
 *   *acting caller's own* membership in the target workspace
 *   (`resolveRequestActorForWorkspace`), never the workspace's oldest member.
 *   This is what makes `acceptInvitation` attribute the join to the invitee,
 *   not to whoever created the workspace first. It never touches the
 *   process-wide globals, so one tenant's workspace switch can never leak
 *   into another concurrent request's default or the loopback CLI surface's
 *   default — each browser session resolves its own workspace from its own
 *   memberships in `requireAuthenticatedSession` regardless of this fallback.
 * - **No request context** (bootstrap/tests/loopback — no production request
 *   handler ever runs outside one): there is no authenticated caller to
 *   attribute to, so it falls back to the workspace's oldest active member
 *   (`resolveActorForWorkspace`) and writes the process-wide fallback via
 *   `setProcessDefaultWorkspace`.
 *
 * Returns the new workspace row, or `null` if `id` does not resolve to an
 * existing (non-deleted) workspace.
 */
export async function setActiveWorkspace(id: string): Promise<WorkspaceRow | null> {
  const row = await loadWorkspaceRowAsync(id);
  if (!row) return null;
  const workspace: ActiveWorkspace = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };

  if (!requestContextStorage.getStore()) {
    const actorWorkspaceUserId = await resolveActorForWorkspace(row.id);
    setProcessDefaultWorkspace(workspace, actorWorkspaceUserId);
    return row;
  }

  const actorWorkspaceUserId =
    (await resolveRequestActorForWorkspace(row.id)) ?? (await resolveActorForWorkspace(row.id));
  mutateRequestContext({
    ...requestContext(),
    activeWorkspace: workspace,
    actorWorkspaceUserId
  });
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

/** Resolve a workspace row by id. Exported for auth's per-request/per-token resolution. */
export const loadWorkspaceRow = loadWorkspaceRowAsync;

async function refreshActiveWorkspaceFromClient(client: DatabaseClient): Promise<void> {
  const row = await oldestWorkspaceRowFromClient(client);
  if (!row) {
    throw new Error('No workspace found in the database. Re-run migrations to seed it.');
  }
  setProcessDefaultWorkspace(
    { id: row.id, slug: row.slug, name: row.name, kind: row.kind },
    await resolveActorForWorkspace(row.id, client)
  );
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
    ...requestContext(),
    actorWorkspaceUserId: workspaceUserId,
    activeTokenId: null,
    activeTokenScopes: null
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
    ...requestContext(),
    actorWorkspaceUserId: workspaceUserId,
    activeTokenId: tokenId,
    activeTokenScopes: scopeGrants && scopeGrants.length > 0 ? scopeGrants : null
  });
}

/**
 * Re-read the active workspace row after it was mutated in place (e.g. a
 * rename) so `getActiveWorkspace()`/`WORKSPACE` — and everything derived from
 * them, like `/api/meta` — reflect the new values. Refreshes both the current
 * request's tenant scoping and the process-wide fallback when they pointed at
 * the same (just-renamed) workspace.
 */
export async function reloadActiveWorkspace(): Promise<void> {
  const id = getActiveWorkspaceId();
  const row = await loadWorkspaceRowAsync(id);
  if (!row) return;
  const refreshed: ActiveWorkspace = { id: row.id, slug: row.slug, name: row.name, kind: row.kind };
  if (id === defaultWorkspace.id) defaultWorkspace = refreshed;
  if (requestContextStorage.getStore()) setActiveWorkspaceContext(refreshed);
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
    workspaceId: input.workspaceId ?? getActiveWorkspaceId(),
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
