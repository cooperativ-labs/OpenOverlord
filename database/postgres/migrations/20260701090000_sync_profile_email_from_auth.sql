-- Promote email to the primary user identifier: keep profiles.email mirrored
-- from the authoritative Better Auth account email, the same way
-- profiles.handle already mirrors the account name.
--
-- Contract: database/docs/09-database-schema-contract.md -> profiles

BEGIN;

CREATE FUNCTION sync_profile_email_from_better_auth_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE profiles
     SET email = NEW."email",
         updated_at = now(),
         revision = revision + 1
   WHERE id = NEW."id"
     AND email IS DISTINCT FROM NEW."email";
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_better_auth_user_sync_profile_email
AFTER UPDATE OF "email" ON "user"
FOR EACH ROW
WHEN (NEW."email" IS DISTINCT FROM OLD."email")
EXECUTE FUNCTION sync_profile_email_from_better_auth_user();

COMMIT;
