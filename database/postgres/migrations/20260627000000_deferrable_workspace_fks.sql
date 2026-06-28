-- Make tenant-scoped PostgreSQL foreign keys deferrable.
--
-- Workspace setup can re-key the seeded workspace in one transaction by updating
-- every workspace_id-bearing table, then the workspaces row itself. PostgreSQL
-- must defer these cross-table checks until commit so the transaction can move a
-- complete workspace graph without transient FK failures.

BEGIN;

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname = current_schema()
       AND EXISTS (
         SELECT 1
           FROM unnest(con.conkey) AS key(attnum)
           JOIN pg_attribute a
             ON a.attrelid = con.conrelid
            AND a.attnum = key.attnum
          WHERE a.attname = 'workspace_id'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      fk.schema_name,
      fk.table_name,
      fk.constraint_name
    );
  END LOOP;
END $$;

COMMIT;
