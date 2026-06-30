-- Remove the legacy implicit local user from untouched fresh databases.
-- The first human identity is now created by Better Auth sign-up in the webapp.

BEGIN;

CREATE TEMP TABLE _remove_seed_local_user AS
SELECT
  EXISTS (
    SELECT 1
      FROM "user"
     WHERE "id" = 'local-user'
       AND "name" = 'Local User'
       AND "email" = 'local@overlord.local'
  )
  AND NOT EXISTS (SELECT 1 FROM "session" WHERE "userId" = 'local-user')
  AND NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = 'local-user')
  AND NOT EXISTS (SELECT 1 FROM user_tokens WHERE profile_id = 'local-user')
  AND NOT EXISTS (SELECT 1 FROM user_execution_target_preferences WHERE profile_id = 'local-user')
  AND NOT EXISTS (SELECT 1 FROM workspace_user_execution_targets WHERE workspace_user_id = 'local-workspace-user')
  AND NOT EXISTS (SELECT 1 FROM project_user_preferences WHERE workspace_user_id = 'local-workspace-user')
  AND NOT EXISTS (SELECT 1 FROM projects WHERE created_by_workspace_user_id = 'local-workspace-user')
  AND NOT EXISTS (SELECT 1 FROM missions WHERE created_by_workspace_user_id = 'local-workspace-user')
  AS should_remove;

DELETE FROM role_assignments
 WHERE workspace_user_id = 'local-workspace-user'
   AND EXISTS (SELECT 1 FROM _remove_seed_local_user WHERE should_remove);

DELETE FROM workspace_users
 WHERE id = 'local-workspace-user'
   AND profile_id = 'local-user'
   AND EXISTS (SELECT 1 FROM _remove_seed_local_user WHERE should_remove);

DELETE FROM profiles
 WHERE id = 'local-user'
   AND EXISTS (SELECT 1 FROM _remove_seed_local_user WHERE should_remove);

DELETE FROM "user"
 WHERE "id" = 'local-user'
   AND "name" = 'Local User'
   AND "email" = 'local@overlord.local'
   AND EXISTS (SELECT 1 FROM _remove_seed_local_user WHERE should_remove);

DROP TABLE _remove_seed_local_user;

COMMIT;
