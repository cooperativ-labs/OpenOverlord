import { bindBool, type DatabaseClient, DEFAULT_STATUSES } from '@overlord/database';
import type Database from 'better-sqlite3';

/**
 * Stable organization id every test bootstrap helper below creates (idempotently)
 * alongside its default `workspaceId`. Exported so test files that call
 * `createWorkspace`/`createOrganizationOnboarding` directly (rather than only
 * seeding rows) can pass a real, existing `organizationId`.
 *
 * Historically these helpers assumed the migration-seeded `local-workspace` row
 * already existed; the organizations migration (coo:135) deletes that pristine
 * seed on a fresh install (Q10 — fresh instances boot with zero orgs/workspaces),
 * so the row must be created here instead of assumed.
 */
export const DEFAULT_TEST_ORGANIZATION_ID = 'test-organization';

export function seedAuthenticatedOperator({
  db,
  organizationId = DEFAULT_TEST_ORGANIZATION_ID,
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  db: Database.Database;
  organizationId?: string;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): string {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, settings_json, created_at, updated_at, revision)
     VALUES (?, ?, '{}', ?, ?, 1)`
  ).run(organizationId, 'Test Organization', now, now);

  db.prepare(
    `INSERT OR IGNORE INTO workspaces (
       id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, 'local', '{}', ?, ?, 1)`
  ).run(workspaceId, organizationId, workspaceId, workspaceId, now, now);

  // Migrations 001-004 used to seed these for the pristine `local-workspace`
  // row; the organizations migration (coo:135) deletes that seed on a fresh
  // install (Q10), so every workspace a test creates must seed its own
  // default statuses/buckets the same way `createWorkspace` does in production.
  for (const status of DEFAULT_STATUSES) {
    db.prepare(
      `INSERT OR IGNORE INTO workspace_statuses
         (id, workspace_id, key, name, type, position, is_default, is_terminal,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      `${workspaceId}-${status.key}`,
      workspaceId,
      status.key,
      status.name,
      status.type,
      status.position,
      bindBool('sqlite', status.isDefault),
      bindBool('sqlite', status.isTerminal),
      now,
      now
    );
  }
  for (const bucketKey of ['workspace-images', 'user-images', 'attachments']) {
    db.prepare(
      `INSERT OR IGNORE INTO storage_buckets (
         id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'local_fs', NULL, 'database/.local/storage', '{}', ?, ?, 1)`
    ).run(`${workspaceId}-${bucketKey}`, workspaceId, bucketKey, now, now);
  }

  db.prepare(
    `INSERT OR IGNORE INTO "user" (
       "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
     ) VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run(profileId, profileId, `${profileId}@overlord.local`, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO workspace_users (
       id, workspace_id, profile_id, member_key, status, metadata_json,
       created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`
  ).run(workspaceUserId, workspaceId, profileId, `auth:${profileId}`, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO role_assignments (
       id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
       assigned_by_workspace_user_id, created_at, updated_at, revision
     ) VALUES (?, ?, ?, 'ADMIN', '', '', ?, ?, ?, 1)`
  ).run(`${workspaceUserId}-admin-role`, workspaceId, workspaceUserId, workspaceUserId, now, now);

  return workspaceUserId;
}

/** Seed an operator on any {@link DatabaseClient} (SQLite or Postgres). */
export async function seedAuthenticatedOperatorClient({
  client,
  organizationId = DEFAULT_TEST_ORGANIZATION_ID,
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  client: DatabaseClient;
  organizationId?: string;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): Promise<string> {
  const now = new Date().toISOString();
  const email = `${profileId}@overlord.local`;
  const emailVerified = client.dialect === 'postgres' ? true : 1;

  const existingOrganization = await client.get<{ id: string }>(
    `SELECT id FROM organizations WHERE id = ?`,
    [organizationId]
  );
  if (!existingOrganization) {
    await client.run(
      `INSERT INTO organizations (id, name, settings_json, created_at, updated_at, revision)
       VALUES (?, ?, '{}', ?, ?, 1)`,
      [organizationId, 'Test Organization', now, now]
    );
  }

  const existingWorkspace = await client.get<{ id: string }>(
    `SELECT id FROM workspaces WHERE id = ?`,
    [workspaceId]
  );
  if (!existingWorkspace) {
    await client.run(
      `INSERT INTO workspaces (
         id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, 'local', '{}', ?, ?, 1)`,
      [workspaceId, organizationId, workspaceId, workspaceId, now, now]
    );
    // Migrations 001-004 used to seed these for the pristine `local-workspace`
    // row; the organizations migration (coo:135) deletes that seed on a fresh
    // install (Q10), so every workspace a test creates must seed its own
    // default statuses/buckets the same way `createWorkspace` does in production.
    for (const status of DEFAULT_STATUSES) {
      await client.run(
        `INSERT INTO workspace_statuses
           (id, workspace_id, key, name, type, position, is_default, is_terminal,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          `${workspaceId}-${status.key}`,
          workspaceId,
          status.key,
          status.name,
          status.type,
          status.position,
          bindBool(client.dialect, status.isDefault),
          bindBool(client.dialect, status.isTerminal),
          now,
          now
        ]
      );
    }
    for (const bucketKey of ['workspace-images', 'user-images', 'attachments']) {
      await client.run(
        `INSERT INTO storage_buckets (
           id, workspace_id, bucket_key, storage_backend, base_url, local_path, settings_json,
           created_at, updated_at, revision
         ) VALUES (?, ?, ?, 'local_fs', NULL, 'database/.local/storage', '{}', ?, ?, 1)`,
        [`${workspaceId}-${bucketKey}`, workspaceId, bucketKey, now, now]
      );
    }
  }

  const existingUser = await client.get<{ id: string }>(`SELECT id FROM "user" WHERE id = ?`, [
    profileId
  ]);
  if (!existingUser) {
    await client.run(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      [profileId, profileId, email, emailVerified, now, now]
    );
  }

  const existingMember = await client.get<{ id: string }>(
    `SELECT id FROM workspace_users WHERE id = ?`,
    [workspaceUserId]
  );
  if (!existingMember) {
    await client.run(
      `INSERT INTO workspace_users (
         id, workspace_id, profile_id, member_key, status, metadata_json,
         created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
      [workspaceUserId, workspaceId, profileId, `auth:${profileId}`, now, now]
    );
  }

  const roleId = `${workspaceUserId}-admin-role`;
  const existingRole = await client.get<{ id: string }>(
    `SELECT id FROM role_assignments WHERE id = ?`,
    [roleId]
  );
  if (!existingRole) {
    await client.run(
      `INSERT INTO role_assignments (
         id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
         assigned_by_workspace_user_id, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'ADMIN', '', '', ?, ?, ?, 1)`,
      [roleId, workspaceId, workspaceUserId, workspaceUserId, now, now]
    );
  }

  return workspaceUserId;
}

/**
 * Point the webapp server modules at an already-migrated {@link DatabaseClient}
 * and seed an ADMIN operator for workspace mutations.
 */
export async function bindWebappDatabaseClient({
  client,
  organizationId = DEFAULT_TEST_ORGANIZATION_ID,
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  client: DatabaseClient;
  organizationId?: string;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): Promise<string> {
  const operatorWorkspaceUserId = await seedAuthenticatedOperatorClient({
    client,
    organizationId,
    workspaceId,
    profileId,
    workspaceUserId
  });

  const dbModule = await import('./db.ts');
  // The workspace/organization rows above are seeded *before* this, so the
  // client-bind's active-workspace refresh (which picks the oldest live
  // workspace) already finds a real row — see the ordering note on
  // `bootstrapIntegrationTestDb` below, which must instead re-refresh after
  // seeding since `initDatabase()` there runs first, against an empty DB.
  await dbModule.bindDatabaseClient(client);
  dbModule.setActiveWorkspaceUser(operatorWorkspaceUserId);
  return operatorWorkspaceUserId;
}

/** Bootstrap a fresh SQLite integration DB with migrations and an ADMIN operator. */
export async function bootstrapIntegrationTestDb({
  sqlitePath,
  organizationId = DEFAULT_TEST_ORGANIZATION_ID,
  workspaceId = 'local-workspace'
}: {
  sqlitePath: string;
  organizationId?: string;
  workspaceId?: string;
}): Promise<{
  db: Database.Database;
  operatorWorkspaceUserId: string;
  setActiveWorkspaceUser: (workspaceUserId: string) => void;
  WORKSPACE: { id: string; slug: string; name: string; kind: string };
}> {
  process.env.OVERLORD_SQLITE_PATH = sqlitePath;
  const dbModule = await import('./db.ts');
  // `initDatabase()` runs its active-workspace refresh against a still-empty
  // (zero-workspace, Q10) database here, before the seed below creates one —
  // unlike `bindWebappDatabaseClient`, which seeds first. Re-point the
  // process-wide default workspace explicitly afterward rather than relying
  // on that refresh.
  await dbModule.initDatabase();
  const operatorWorkspaceUserId = seedAuthenticatedOperator({
    db: dbModule.db,
    organizationId,
    workspaceId
  });
  await dbModule.setActiveWorkspace(workspaceId);
  dbModule.setActiveWorkspaceUser(operatorWorkspaceUserId);
  return {
    db: dbModule.db,
    operatorWorkspaceUserId,
    setActiveWorkspaceUser: dbModule.setActiveWorkspaceUser,
    WORKSPACE: dbModule.WORKSPACE
  };
}
