-- Make objectives' composite (project_id, mission_id) FK deferrable.
--
-- Cross-project mission moves repoint denormalized project_id on objectives
-- before missions.project_id within one transaction. PostgreSQL must defer
-- this check until commit (mirrors SQLite's foreign_keys=OFF around the move).

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
       AND c.relname = 'objectives'
       AND EXISTS (
         SELECT 1
           FROM unnest(con.conkey) AS key(attnum)
           JOIN pg_attribute a
             ON a.attrelid = con.conrelid
            AND a.attnum = key.attnum
          WHERE a.attname = 'project_id'
       )
       AND EXISTS (
         SELECT 1
           FROM unnest(con.conkey) AS key(attnum)
           JOIN pg_attribute a
             ON a.attrelid = con.conrelid
            AND a.attnum = key.attnum
          WHERE a.attname = 'mission_id'
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
