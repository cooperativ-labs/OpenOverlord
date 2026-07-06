import type { BetterSqlite3Database } from './better-sqlite3-loader.js';
import type { DatabaseClient } from './client.js';

export const EXT_EVERHOUR_MIGRATION_VERSION = '20260706000000';

export function isExtEverhourPersistenceMigration(migration: {
  version: string;
  component: string;
}): boolean {
  return (
    migration.version === EXT_EVERHOUR_MIGRATION_VERSION && migration.component === 'ext:everhour'
  );
}

function missionsHasEverhourTaskIdColumnSqlite(db: BetterSqlite3Database): boolean {
  const columns = db.prepare(`PRAGMA table_info(missions)`).all() as Array<{ name: string }>;
  return columns.some(column => column.name === 'everhour_task_id');
}

async function missionsHasEverhourTaskIdColumnPostgres(client: DatabaseClient): Promise<boolean> {
  const row = await client.get<{ present: number }>(
    `SELECT 1 AS present
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'missions'
        AND column_name = 'everhour_task_id'`
  );
  return Boolean(row?.present);
}

/**
 * Backfill mission links from the removed core `missions.everhour_task_id` column
 * when upgrading databases that applied the retired core migration, then drop
 * the legacy column. Fresh installs skip this step.
 */
export function finalizeExtEverhourMissionLinksSqlite(db: BetterSqlite3Database): void {
  if (!missionsHasEverhourTaskIdColumnSqlite(db)) return;

  db.exec(`
    INSERT OR IGNORE INTO ext_everhour_mission_links (
      id, workspace_id, project_id, mission_id, everhour_task_id, created_at, updated_at, revision
    )
    SELECT
      lower(hex(randomblob(16))),
      m.workspace_id,
      m.project_id,
      m.id,
      m.everhour_task_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      1
    FROM missions m
    WHERE m.deleted_at IS NULL
      AND m.everhour_task_id IS NOT NULL
      AND length(trim(m.everhour_task_id)) > 0
  `);
  db.exec(`ALTER TABLE missions DROP COLUMN everhour_task_id`);
}

export async function finalizeExtEverhourMissionLinksPostgres(
  client: DatabaseClient
): Promise<void> {
  if (!(await missionsHasEverhourTaskIdColumnPostgres(client))) return;

  await client.exec(`
    INSERT INTO ext_everhour_mission_links (
      id, workspace_id, project_id, mission_id, everhour_task_id, created_at, updated_at, revision
    )
    SELECT
      gen_random_uuid()::text,
      m.workspace_id,
      m.project_id,
      m.id,
      m.everhour_task_id,
      now(),
      now(),
      1
    FROM missions m
    WHERE m.deleted_at IS NULL
      AND m.everhour_task_id IS NOT NULL
      AND char_length(btrim(m.everhour_task_id)) > 0
    ON CONFLICT DO NOTHING
  `);
  await client.exec(`ALTER TABLE missions DROP COLUMN IF EXISTS everhour_task_id`);
}
