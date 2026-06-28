import { type DatabaseClient } from '@overlord/database';
import type Database from 'better-sqlite3';

export function seedAuthenticatedOperator({
  db,
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  db: Database.Database;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): string {
  const now = new Date().toISOString();

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
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  client: DatabaseClient;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): Promise<string> {
  const now = new Date().toISOString();
  const email = `${profileId}@overlord.local`;
  const emailVerified = client.dialect === 'postgres' ? true : 1;

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
  const existingRole = await client.get<{ id: string }>(`SELECT id FROM role_assignments WHERE id = ?`, [
    roleId
  ]);
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
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  client: DatabaseClient;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): Promise<string> {
  const operatorWorkspaceUserId = await seedAuthenticatedOperatorClient({
    client,
    workspaceId,
    profileId,
    workspaceUserId
  });

  const dbModule = await import('./db.ts');
  await dbModule.bindDatabaseClient(client);
  dbModule.setActiveWorkspaceUser(operatorWorkspaceUserId);
  return operatorWorkspaceUserId;
}

/** Bootstrap a fresh SQLite integration DB with migrations and an ADMIN operator. */
export async function bootstrapIntegrationTestDb({ sqlitePath }: { sqlitePath: string }): Promise<{
  db: Database.Database;
  operatorWorkspaceUserId: string;
  setActiveWorkspaceUser: (workspaceUserId: string) => void;
  WORKSPACE: { id: string; slug: string; name: string; kind: string };
}> {
  process.env.OVERLORD_SQLITE_PATH = sqlitePath;
  const dbModule = await import('./db.ts');
  await dbModule.initDatabase();
  const operatorWorkspaceUserId = seedAuthenticatedOperator({ db: dbModule.db });
  dbModule.setActiveWorkspaceUser(operatorWorkspaceUserId);
  return {
    db: dbModule.db,
    operatorWorkspaceUserId,
    setActiveWorkspaceUser: dbModule.setActiveWorkspaceUser,
    WORKSPACE: dbModule.WORKSPACE
  };
}
