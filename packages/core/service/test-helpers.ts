import type { DatabaseClient } from '@overlord/database';

export async function seedServiceOperator({
  db,
  workspaceId = 'local-workspace',
  profileId = 'operator-user',
  workspaceUserId = 'operator-workspace-user'
}: {
  db: DatabaseClient;
  workspaceId?: string;
  profileId?: string;
  workspaceUserId?: string;
}): Promise<string> {
  const now = new Date().toISOString();

  await db.run(
    `INSERT OR IGNORE INTO "user" (
       "id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"
     ) VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    [profileId, profileId, `${profileId}@overlord.local`, now, now]
  );

  await db.run(
    `INSERT OR IGNORE INTO workspace_users (
       id, workspace_id, profile_id, member_key, status, metadata_json,
       created_at, updated_at, revision
     ) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`,
    [workspaceUserId, workspaceId, profileId, `auth:${profileId}`, now, now]
  );

  await db.run(
    `INSERT OR IGNORE INTO role_assignments (
       id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
       assigned_by_workspace_user_id, created_at, updated_at, revision
     ) VALUES (?, ?, ?, 'ADMIN', '', '', ?, ?, ?, 1)`,
    [`${workspaceUserId}-admin-role`, workspaceId, workspaceUserId, workspaceUserId, now, now]
  );

  return workspaceUserId;
}
