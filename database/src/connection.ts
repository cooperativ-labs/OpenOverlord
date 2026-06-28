import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BetterSqlite3Database, loadBetterSqlite3 } from './better-sqlite3-loader.js';
import { CONTRACT_VERSION } from './constants.js';
import { resolveGlobalDatabasePath } from './local-paths.js';

const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_]+\.sql$/;

export type OverlordDatabase = BetterSqlite3Database;

/**
 * The SQLite migrations ship inside this package (`@overlord/database`) and are
 * resolved relative to this module, so the lookup works identically when run
 * from TypeScript source, from the compiled `dist/`, or from a copy bundled into
 * the CLI tarball — no repo-root heuristics required.
 */
function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sqlite', 'migrations');
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function loadMigrationSql(fileName: string): { version: string; sql: string; checksum: string } {
  const version = fileName.split('_', 1)[0] ?? fileName;
  const filePath = path.join(migrationsDir(), fileName);
  const sql = readFileSync(filePath, 'utf8');
  return { version, sql, checksum: checksum(sql) };
}

export function listSqliteMigrationFiles(): string[] {
  return readdirSync(migrationsDir())
    .filter(fileName => MIGRATION_FILE_PATTERN.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

function applyMigration(
  db: OverlordDatabase,
  migration: ReturnType<typeof loadMigrationSql>
): void {
  const applied = db
    .prepare(
      `SELECT checksum FROM schema_migrations
       WHERE adapter = 'sqlite' AND component = 'core' AND version = ?`
    )
    .get(migration.version) as { checksum: string } | undefined;

  if (applied) {
    if (applied.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version} checksum mismatch ` +
          `(stored ${applied.checksum}, file ${migration.checksum}).`
      );
    }
    return;
  }

  db.exec(migration.sql);
  db.prepare(
    `INSERT INTO schema_migrations (version, adapter, component, contract_version, checksum, applied_at)
     VALUES (?, 'sqlite', 'core', ?, ?, ?)`
  ).run(migration.version, CONTRACT_VERSION, migration.checksum, new Date().toISOString());
}

export function openDatabase({ databasePath }: { databasePath: string }): OverlordDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const Database = loadBetterSqlite3();
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.pragma('journal_mode = DELETE');
  }
  return db;
}

export function migrateDatabase(db: OverlordDatabase): void {
  const pendingMigrationRecords: Array<ReturnType<typeof loadMigrationSql>> = [];
  for (const fileName of listSqliteMigrationFiles()) {
    const migration = loadMigrationSql(fileName);
    const hasSchema = db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'`)
      .get();
    if (!hasSchema) {
      db.exec(migration.sql);
      const createdSchema = db
        .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'`)
        .get();
      if (!createdSchema) {
        pendingMigrationRecords.push(migration);
        continue;
      }
      for (const pending of [...pendingMigrationRecords, migration]) {
        db.prepare(
          `INSERT INTO schema_migrations (version, adapter, component, contract_version, checksum, applied_at)
           VALUES (?, 'sqlite', 'core', ?, ?, ?)`
        ).run(pending.version, CONTRACT_VERSION, pending.checksum, new Date().toISOString());
      }
      pendingMigrationRecords.length = 0;
      continue;
    }
    applyMigration(db, migration);
  }
}

export function openInMemoryDatabase(): OverlordDatabase {
  const Database = loadBetterSqlite3();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

export function resolveDefaultDatabasePath(startDir = process.cwd()): string {
  const explicit = process.env.OVERLORD_SQLITE_PATH;
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(startDir, explicit);
  }
  return resolveGlobalDatabasePath();
}

/**
 * Convert any relative `local_path` values in `storage_buckets` to absolute
 * paths derived from the database file's directory. This makes local storage
 * follow the database regardless of where it lives — when `database_path` in
 * `overlord.toml` points to `~/.ovld/Overlord.sqlite`, storage lands at
 * `~/.ovld/storage/<bucket_key>` instead of resolving relative to the repo.
 *
 * Idempotent: rows with an already-absolute `local_path` are skipped.
 */
export function fixupLocalStoragePaths(db: OverlordDatabase, databasePath: string): void {
  const storageDir = path.join(path.dirname(path.resolve(databasePath)), 'storage');

  const buckets = db
    .prepare(
      `SELECT id, bucket_key, local_path FROM storage_buckets
       WHERE storage_backend = 'local_fs' AND deleted_at IS NULL`
    )
    .all() as Array<{ id: string; bucket_key: string; local_path: string | null }>;

  const update = db.prepare(
    `UPDATE storage_buckets SET local_path = ?, updated_at = ? WHERE id = ?`
  );

  const now = new Date().toISOString();
  for (const bucket of buckets) {
    if (!bucket.local_path || path.isAbsolute(bucket.local_path)) continue;
    update.run(path.join(storageDir, bucket.bucket_key), now, bucket.id);
  }
}
