import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_VERSION = '0.2-draft';
const DEFAULT_DATABASE_PATH = '.overlord/Overlord.sqlite';
const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_]+\.sql$/;

type BetterSqlite3Constructor = typeof import('better-sqlite3');
type DatabaseInstance = import('better-sqlite3').Database;

type Migration = {
  version: string;
  fileName: string;
  sql: string;
  checksum: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveDatabasePath(): string {
  const explicitPath = process.env.OVERLORD_SQLITE_PATH;
  return path.resolve(repoRoot, explicitPath ?? DEFAULT_DATABASE_PATH);
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function loadMigration(fileName: string): Migration {
  const version = fileName.split('_', 1)[0];
  if (!version) {
    throw new Error(`Migration ${fileName} does not start with a version.`);
  }

  const filePath = path.join(repoRoot, 'database', 'sqlite', 'migrations', fileName);
  const sql = readFileSync(filePath, 'utf8');

  return {
    version,
    fileName,
    sql,
    checksum: checksum(sql)
  };
}

function listMigrationFiles(): string[] {
  const migrationDir = path.join(repoRoot, 'database', 'sqlite', 'migrations');
  return readdirSync(migrationDir)
    .filter(fileName => MIGRATION_FILE_PATTERN.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

function applyMigration(db: DatabaseInstance, migration: Migration): 'applied' | 'skipped' {
  const applied = db
    .prepare(
      `
      SELECT checksum
      FROM schema_migrations
      WHERE adapter = 'sqlite'
        AND component = 'core'
        AND version = ?
      `
    )
    .get(migration.version) as { checksum: string } | undefined;

  if (applied) {
    if (applied.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version} was already applied with a different checksum.`
      );
    }
    return 'skipped';
  }

  db.exec(migration.sql);
  db.prepare(
    `
    INSERT INTO schema_migrations (
      version, adapter, component, contract_version, checksum, applied_at
    ) VALUES (?, 'sqlite', 'core', ?, ?, ?)
    `
  ).run(migration.version, CONTRACT_VERSION, migration.checksum, new Date().toISOString());

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
    for (const migration of migrations) {
      const state =
        migration.version === '001'
          ? applyInitialMigration(db, migration)
          : applyMigration(db, migration);
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

function applyInitialMigration(db: DatabaseInstance, migration: Migration): 'applied' | 'skipped' {
  const hasSchemaMigrations = db
    .prepare(
      `
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'schema_migrations'
      `
    )
    .get();

  if (!hasSchemaMigrations) {
    db.exec(migration.sql);
    db.prepare(
      `
      INSERT INTO schema_migrations (
        version, adapter, component, contract_version, checksum, applied_at
      ) VALUES (?, 'sqlite', 'core', ?, ?, ?)
      `
    ).run(migration.version, CONTRACT_VERSION, migration.checksum, new Date().toISOString());
    return 'applied';
  }

  return applyMigration(db, migration);
}

void main();
