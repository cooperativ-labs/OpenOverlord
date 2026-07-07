import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_VERSION } from './constants.js';
import {
  finalizeExtEverhourMissionLinksSqlite,
  isExtEverhourPersistenceMigration
} from './ext-everhour-migration-runtime.js';
import { resolveGlobalDatabasePath } from './local-paths.js';
import {
  knownMigrationVersions,
  pruneObsoleteMigrationLedgerSqlite,
  resolveAppliedMigrationSqlite
} from './migration-ledger.js';
import {
  finalizeProjectResourcesResourceKeySqlite,
  isProjectResourcesResourceKeyMigration
} from './project-resources-resource-key-migration-runtime.js';

const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_]+\.sql$/;

type BetterSqlite3Constructor = typeof import('better-sqlite3');
type DatabaseInstance = import('better-sqlite3').Database;

type Migration = {
  version: string;
  component: string;
  fileName: string;
  sql: string;
  checksum: string;
};

/** Migrations ship inside this package; resolve them relative to this module. */
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'sqlite',
  'migrations'
);

function resolveDatabasePath(): string {
  const explicitPath = process.env.OVERLORD_SQLITE_PATH;
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(process.cwd(), explicitPath);
  }
  // Default to the per-user global database (`~/.ovld/Overlord.sqlite`) so the
  // launcher targets the same database a globally installed `ovld` would use.
  return resolveGlobalDatabasePath();
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function migrationComponent(fileName: string): string {
  const match = fileName.match(/^\d+_ext_([a-z0-9_]+)_/);
  return match ? `ext:${match[1]}` : 'core';
}

function loadMigration(fileName: string): Migration {
  const version = fileName.split('_', 1)[0];
  if (!version) {
    throw new Error(`Migration ${fileName} does not start with a version.`);
  }

  const filePath = path.join(migrationsDir, fileName);
  const sql = readFileSync(filePath, 'utf8');

  return {
    version,
    component: migrationComponent(fileName),
    fileName,
    sql,
    checksum: checksum(sql)
  };
}

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter(fileName => MIGRATION_FILE_PATTERN.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

function applyMigration(db: DatabaseInstance, migration: Migration): 'applied' | 'skipped' {
  const applied = resolveAppliedMigrationSqlite({
    db,
    migration: {
      version: migration.version,
      component: migration.component,
      checksum: migration.checksum
    }
  });

  if (applied) {
    if (applied.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version} was already applied with a different checksum.`
      );
    }
    return 'skipped';
  }

  db.exec(migration.sql);
  if (isExtEverhourPersistenceMigration(migration)) {
    finalizeExtEverhourMissionLinksSqlite(db);
  }
  if (isProjectResourcesResourceKeyMigration(migration)) {
    finalizeProjectResourcesResourceKeySqlite(db);
  }
  recordMigration(db, migration);

  return 'applied';
}

function describeNativeModuleError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if ('code' in error && error.code === 'ERR_DLOPEN_FAILED') {
    return [
      'Failed to load `better-sqlite3` for the current runtime.',
      `Current runtime: ${process.platform}/${process.arch} on Node ${process.version}.`,
      'This usually means `node_modules` was installed on a different OS or CPU architecture and then reused here.',
      'Reinstall dependencies inside the same environment where you run Overlord.',
      'Suggested fix:',
      '  rm -rf node_modules',
      '  yarn install',
      'Then rerun `yarn start:local`.'
    ].join('\n');
  }

  return null;
}

async function loadBetterSqlite3(): Promise<BetterSqlite3Constructor> {
  try {
    const module = (await import('better-sqlite3')) as { default: BetterSqlite3Constructor };
    return module.default;
  } catch (error) {
    const message = describeNativeModuleError(error);
    if (message) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

async function openDatabase(databasePath: string): Promise<DatabaseInstance> {
  try {
    const Database = await loadBetterSqlite3();
    return new Database(databasePath);
  } catch (error) {
    const message = describeNativeModuleError(error);
    if (message) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const databasePath = resolveDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = await openDatabase(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  const migrations = listMigrationFiles().map(loadMigration);
  const results: string[] = [];

  try {
    if (hasSchemaMigrationsTable(db)) {
      pruneObsoleteMigrationLedgerSqlite({
        db,
        knownVersions: knownMigrationVersions(listMigrationFiles())
      });
    }

    const pendingMigrationRecords: Migration[] = [];
    for (const migration of migrations) {
      const state = applyMigrationWithPendingRecords(db, migration, pendingMigrationRecords);
      results.push(`${migration.fileName}: ${state}`);
    }

    const tableCount = db
      .prepare(
        `
        SELECT count(*) AS count
        FROM sqlite_schema
        WHERE type = 'table'
        `
      )
      .get() as { count: number };

    console.log(`Local Overlord SQLite database is ready: ${databasePath}`);
    console.log(`Tables: ${tableCount.count}`);
    for (const result of results) {
      console.log(result);
    }
  } finally {
    db.close();
  }
}

function hasSchemaMigrationsTable(db: DatabaseInstance): boolean {
  return Boolean(
    db
      .prepare(
        `
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'schema_migrations'
        `
      )
      .get()
  );
}

function recordMigration(db: DatabaseInstance, migration: Migration): void {
  db.prepare(
    `
    INSERT INTO schema_migrations (
      version, adapter, component, contract_version, checksum, applied_at
    ) VALUES (?, 'sqlite', ?, ?, ?, ?)
    `
  ).run(
    migration.version,
    migration.component,
    CONTRACT_VERSION,
    migration.checksum,
    new Date().toISOString()
  );
}

function applyMigrationWithPendingRecords(
  db: DatabaseInstance,
  migration: Migration,
  pendingMigrationRecords: Migration[]
): 'applied' | 'applied-pending' | 'skipped' {
  if (hasSchemaMigrationsTable(db)) return applyMigration(db, migration);

  db.exec(migration.sql);
  if (isExtEverhourPersistenceMigration(migration)) {
    finalizeExtEverhourMissionLinksSqlite(db);
  }
  if (isProjectResourcesResourceKeyMigration(migration)) {
    finalizeProjectResourcesResourceKeySqlite(db);
  }
  if (!hasSchemaMigrationsTable(db)) {
    pendingMigrationRecords.push(migration);
    return 'applied-pending';
  }

  for (const pending of [...pendingMigrationRecords, migration]) {
    recordMigration(db, pending);
  }
  pendingMigrationRecords.length = 0;
  return 'applied';
}

void main();
