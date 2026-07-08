import path from 'node:path';

import type { BetterSqlite3Database } from './better-sqlite3-loader.js';

export const PROJECT_RESOURCES_RESOURCE_KEY_MIGRATION_VERSION = '20260707173400';

export function isProjectResourcesResourceKeyMigration(migration: {
  version: string;
  component: string;
}): boolean {
  return (
    migration.version === PROJECT_RESOURCES_RESOURCE_KEY_MIGRATION_VERSION &&
    migration.component === 'core'
  );
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'project';
}

function deriveProjectResourceKey({
  label,
  directoryPath
}: {
  label: string | null;
  directoryPath: string;
}): string {
  const labelKey = label?.trim();
  if (labelKey) return slugify(labelKey);
  return slugify(path.basename(path.resolve(directoryPath)));
}

function projectResourcesHasResourceKeyColumn(db: BetterSqlite3Database): boolean {
  const columns = db.prepare(`PRAGMA table_info(project_resources)`).all() as Array<{
    name: string;
  }>;
  return columns.some(column => column.name === 'resource_key');
}

export function finalizeProjectResourcesResourceKeySqlite(db: BetterSqlite3Database): void {
  if (!projectResourcesHasResourceKeyColumn(db)) return;

  const rows = db
    .prepare(
      `SELECT id, project_id, execution_target_id, label, path, resource_key, deleted_at, created_at
         FROM project_resources
        ORDER BY created_at ASC, id ASC`
    )
    .all() as Array<{
    id: string;
    project_id: string;
    execution_target_id: string | null;
    label: string | null;
    path: string;
    resource_key: string | null;
    deleted_at: string | null;
    created_at: string;
  }>;

  const update = db.prepare(
    `UPDATE project_resources SET resource_key = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
  );
  const now = new Date().toISOString();
  const usedKeys = new Map<string, Set<string>>();

  for (const row of rows) {
    const existingKey = row.resource_key?.trim();
    let resourceKey =
      existingKey && existingKey.length > 0
        ? slugify(existingKey)
        : deriveProjectResourceKey({ label: row.label, directoryPath: row.path });

    if (row.deleted_at === null) {
      const scopeKey = `${row.project_id}\0${row.execution_target_id ?? ''}`;
      const seen = usedKeys.get(scopeKey) ?? new Set<string>();
      if (seen.has(resourceKey)) {
        resourceKey = `${resourceKey.slice(0, 40)}-${row.id.replace(/-/g, '').slice(0, 7)}`;
      }
      seen.add(resourceKey);
      usedKeys.set(scopeKey, seen);
    }

    if (existingKey === resourceKey) continue;
    update.run(resourceKey, now, row.id);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_resources_active_project_target_key
      ON project_resources (project_id, execution_target_id, resource_key)
      WHERE deleted_at IS NULL
  `);
}
