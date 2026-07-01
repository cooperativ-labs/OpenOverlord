-- Promote email to the primary user identifier: keep profiles.email mirrored
-- from the authoritative Better Auth account email, the same way
-- profiles.handle already mirrors the account name.
--
-- Contract: database/docs/09-database-schema-contract.md -> profiles

BEGIN;

CREATE TRIGGER trg_better_auth_user_sync_profile_email
AFTER UPDATE OF "email" ON "user"
FOR EACH ROW
WHEN NEW."email" IS NOT OLD."email"
BEGIN
  UPDATE profiles
     SET email = NEW."email",
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         revision = revision + 1
   WHERE id = NEW."id"
     AND email IS NOT NEW."email";
END;

COMMIT;
