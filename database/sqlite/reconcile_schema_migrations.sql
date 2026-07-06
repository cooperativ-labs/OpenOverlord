-- Reconcile schema_migrations for the migration consolidation (coo:144), sqlite.
--
-- Run ONCE against an already-migrated sqlite database (dev/staging/hosted)
-- so its schema_migrations rows match the consolidated 001-004 migration files.
-- A fresh install does NOT need this file: the runner records these checksums
-- itself. This file is intentionally NOT named like a migration (no numeric
-- prefix) so the migration runner never auto-discovers or applies it.
--
-- It (1) updates the recorded checksum for every surviving migration to the new
-- file's sha256, and (2) deletes rows for the folded migrations whose files no
-- longer exist. The schema itself is unchanged by consolidation; only the
-- migration ledger is rewritten.

BEGIN;

UPDATE schema_migrations SET checksum = '84319b9c0fd85e92e7196529abf8d6632b3b52dc68acd35db7e48e5fb9030fd8'
 WHERE adapter = 'sqlite' AND component = 'core' AND version = '001';
UPDATE schema_migrations SET checksum = '6e5db4d423270cd2425993656a0958a622621dfe1edcb209f3837b47b85d3b6c'
 WHERE adapter = 'sqlite' AND component = 'core' AND version = '002';
UPDATE schema_migrations SET checksum = 'c51027a0c00b1310f9be6ebbb398641e83d0e8852631b6d54b549721822f3d92'
 WHERE adapter = 'sqlite' AND component = 'core' AND version = '003';
UPDATE schema_migrations SET checksum = '01d0f62e56d48d9201d6743fa0f8729a7d33a12f4538b9e1fc222d0d4410bf89'
 WHERE adapter = 'sqlite' AND component = 'core' AND version = '004';
UPDATE schema_migrations SET checksum = '0fa9fc684ed6dd608031cf9f85eedda273e7d652e75c2248681be07902e62401'
 WHERE adapter = 'sqlite' AND component = 'core' AND version = '20260625000000';

-- Drop ledger rows for every folded migration (files removed by consolidation).
DELETE FROM schema_migrations
 WHERE adapter = 'sqlite' AND component = 'core'
   AND version NOT IN ('001', '002', '003', '004', '20260625000000');

COMMIT;
