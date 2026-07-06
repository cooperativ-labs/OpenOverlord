import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseClient } from './client.js';
import { CONTRACT_VERSION } from './constants.js';

const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_]+\.sql$/;

/**
 * The PostgreSQL migrations ship inside this package (`@overlord/database`)
 * alongside the SQLite ones and are resolved relative to this module, so the
 * lookup works identically from TypeScript source or the compiled `dist/`.
 */
function postgresMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'postgres', 'migrations');
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function migrationComponent(fileName: string): string {
  const match = fileName.match(/^\d+_ext_([a-z0-9_]+)_/);
  return match ? `ext:${match[1]}` : 'core';
}

function loadMigrationSql(fileName: string): {
  version: string;
  component: string;
  sql: string;
  checksum: string;
} {
  // Match the SQLite convention (`connection.ts`): the version is the numeric
  // filename prefix, so the same logical migration shares a version across
  // adapters.
  const version = fileName.split('_', 1)[0] ?? fileName;
  const sql = readFileSync(path.join(postgresMigrationsDir(), fileName), 'utf8');
  return { version, component: migrationComponent(fileName), sql, checksum: checksum(sql) };
}

export function listPostgresMigrationFiles(): string[] {
  return readdirSync(postgresMigrationsDir())
    .filter(fileName => MIGRATION_FILE_PATTERN.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

async function schemaMigrationsExists(client: DatabaseClient): Promise<boolean> {
  const row = await client.get<{ present: string | null }>(
    `SELECT to_regclass('schema_migrations') AS present`
  );
  return Boolean(row?.present);
}

async function recordMigration(
  client: DatabaseClient,
  migration: ReturnType<typeof loadMigrationSql>
): Promise<void> {
  await client.run(
    `INSERT INTO schema_migrations (version, adapter, component, contract_version, checksum, applied_at)
     VALUES (?, 'postgres', ?, ?, ?, ?)`,
    [
      migration.version,
      migration.component,
      CONTRACT_VERSION,
      migration.checksum,
      new Date().toISOString()
    ]
  );
}

/**
 * Apply the bundled PostgreSQL migrations against `client`, tracking applied
 * versions in `schema_migrations` (adapter `'postgres'`). Mirrors the SQLite
 * `migrateDatabase` semantics: idempotent (already-applied versions are skipped
 * after a checksum check), and it bootstraps the `schema_migrations` table —
 * created inside `002_initial_core.sql` — by buffering the migrations that run
 * before the table exists and recording them once it does.
 */
export async function migratePostgres(client: DatabaseClient): Promise<void> {
  if (client.dialect !== 'postgres') {
    throw new Error(`migratePostgres requires a postgres client, got '${client.dialect}'`);
  }

  const pending: Array<ReturnType<typeof loadMigrationSql>> = [];
  for (const fileName of listPostgresMigrationFiles()) {
    const migration = loadMigrationSql(fileName);

    if (!(await schemaMigrationsExists(client))) {
      await client.exec(migration.sql);
      if (!(await schemaMigrationsExists(client))) {
        pending.push(migration);
        continue;
      }
      for (const buffered of [...pending, migration]) {
        await recordMigration(client, buffered);
      }
      pending.length = 0;
      continue;
    }

    const applied = await client.get<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations
        WHERE adapter = 'postgres' AND component = ? AND version = ?`,
      [migration.component, migration.version]
    );
    if (applied) {
      if (applied.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} checksum mismatch ` +
            `(stored ${applied.checksum}, file ${migration.checksum}).`
        );
      }
      continue;
    }

    await client.exec(migration.sql);
    await recordMigration(client, migration);
  }
}
