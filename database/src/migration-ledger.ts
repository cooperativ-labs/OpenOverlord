import type { BetterSqlite3Database } from './better-sqlite3-loader.js';
import type { DatabaseClient } from './client.js';

export function knownMigrationVersions(fileNames: string[]): Set<string> {
  return new Set(fileNames.map(fileName => fileName.split('_', 1)[0] ?? fileName));
}

export async function pruneObsoleteMigrationLedgerPostgres({
  client,
  knownVersions
}: {
  client: DatabaseClient;
  knownVersions: Set<string>;
}): Promise<void> {
  const rows = await client.all<{ version: string }>(
    `SELECT version FROM schema_migrations WHERE adapter = 'postgres'`
  );
  for (const row of rows) {
    if (knownVersions.has(row.version)) continue;
    await client.run(
      `DELETE FROM schema_migrations
        WHERE adapter = 'postgres' AND version = ?`,
      [row.version]
    );
  }
}

export function pruneObsoleteMigrationLedgerSqlite({
  db,
  knownVersions
}: {
  db: BetterSqlite3Database;
  knownVersions: Set<string>;
}): void {
  const rows = db
    .prepare(`SELECT version FROM schema_migrations WHERE adapter = 'sqlite'`)
    .all() as Array<{ version: string }>;
  for (const row of rows) {
    if (knownVersions.has(row.version)) continue;
    db.prepare(
      `DELETE FROM schema_migrations
        WHERE adapter = 'sqlite' AND version = ?`
    ).run(row.version);
  }
}

export async function resolveAppliedMigrationPostgres({
  client,
  migration
}: {
  client: DatabaseClient;
  migration: { version: string; component: string; checksum: string };
}): Promise<{ checksum: string } | undefined> {
  const applied = await client.get<{ checksum: string }>(
    `SELECT checksum FROM schema_migrations
      WHERE adapter = 'postgres' AND component = ? AND version = ?`,
    [migration.component, migration.version]
  );
  if (applied) return applied;

  if (!migration.component.startsWith('ext:')) return undefined;

  const legacy = await client.get<{ checksum: string }>(
    `SELECT checksum FROM schema_migrations
      WHERE adapter = 'postgres' AND component = 'core' AND version = ?`,
    [migration.version]
  );
  if (!legacy || legacy.checksum !== migration.checksum) return undefined;

  await client.run(
    `UPDATE schema_migrations
        SET component = ?
      WHERE adapter = 'postgres' AND component = 'core' AND version = ?`,
    [migration.component, migration.version]
  );
  return legacy;
}

export function resolveAppliedMigrationSqlite({
  db,
  migration
}: {
  db: BetterSqlite3Database;
  migration: { version: string; component: string; checksum: string };
}): { checksum: string } | undefined {
  const applied = db
    .prepare(
      `SELECT checksum FROM schema_migrations
       WHERE adapter = 'sqlite' AND component = ? AND version = ?`
    )
    .get(migration.component, migration.version) as { checksum: string } | undefined;
  if (applied) return applied;

  if (!migration.component.startsWith('ext:')) return undefined;

  const legacy = db
    .prepare(
      `SELECT checksum FROM schema_migrations
       WHERE adapter = 'sqlite' AND component = 'core' AND version = ?`
    )
    .get(migration.version) as { checksum: string } | undefined;
  if (!legacy || legacy.checksum !== migration.checksum) return undefined;

  db.prepare(
    `UPDATE schema_migrations
        SET component = ?
      WHERE adapter = 'sqlite' AND component = 'core' AND version = ?`
  ).run(migration.component, migration.version);
  return legacy;
}
