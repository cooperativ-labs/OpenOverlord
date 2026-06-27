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
