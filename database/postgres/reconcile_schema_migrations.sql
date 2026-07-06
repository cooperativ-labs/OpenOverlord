-- Reconcile schema_migrations for the migration consolidation (coo:144), postgres.
--
-- Run ONCE against an already-migrated postgres database (dev/staging/hosted)
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

UPDATE schema_migrations SET checksum = 'f8df0b3b925e136f55e8d8eaed2baf607c2bc5b8034947309d94324a154a3bd8'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '001';
UPDATE schema_migrations SET checksum = '996d2c40fa464fc7ba77b7363f6a059f920edb0c78d4ca460e70b682de602ac4'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '002';
UPDATE schema_migrations SET checksum = '8a28572eb8e6fded5c50ba3a6474c69a4530dec1a24a46f902f64b1aba76ba8c'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '003';
UPDATE schema_migrations SET checksum = '22b3d8c1edff63f796610c26893c0da26f272bd1dd504ea6fa1457e061802ed6'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '004';
UPDATE schema_migrations SET checksum = '98152aab61c32da775df1e825a502fc9075ce6907e7873e2dc5d564667290cbe'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '20260625000000';
UPDATE schema_migrations SET checksum = 'de312f0defd88089d791f0b923cadb09d9129ae3386f720432358560988f3bcc'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '20260627000000';
UPDATE schema_migrations SET checksum = 'b88c76b5b6a445b1f421398a9c0d58fda244dc9db8fc08a5a224dae82189de47'
 WHERE adapter = 'postgres' AND component = 'core' AND version = '20260705120000';

-- Drop ledger rows for every folded migration (files removed by consolidation).
DELETE FROM schema_migrations
 WHERE adapter = 'postgres' AND component = 'core'
   AND version NOT IN ('001', '002', '003', '004', '20260625000000', '20260627000000', '20260705120000');

COMMIT;
