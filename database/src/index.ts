/**
 * `@overlord/database` — the persistence package for Overlord.
 *
 * Owns the SQLite migrations, the local-development launcher, the connection /
 * migration runtime, the database-layer constants and controlled vocabularies,
 * and the single `resolveAdapter()` adapter-selection point. The CLI, the root
 * service layer, and the auth module all depend on this package instead of
 * reaching across folder boundaries with relative imports.
 */
export { type AdapterConfig, resolveAdapter } from './adapter.js';
export { loadBetterSqlite3 } from './better-sqlite3-loader.js';
export {
  bindBool,
  createPostgresClient,
  createPostgresSessionClient,
  createSqliteClient,
  type DatabaseClient,
  openDatabaseClient,
  type RunResult,
  sqlBoolLiteral,
  type SqlDialect,
  toPostgresPlaceholders
} from './client.js';
export {
  fixupLocalStoragePaths,
  listSqliteMigrationFiles,
  migrateDatabase,
  openDatabase,
  openInMemoryDatabase,
  type OverlordDatabase,
  resolveDefaultDatabasePath
} from './connection.js';
export {
  CONTRACT_VERSION,
  DEFAULT_STATUSES,
  OBJECTIVE_STATES,
  type ObjectiveState,
  SEED_USER_ID,
  SEED_WORKSPACE_ID,
  SEED_WORKSPACE_SLUG,
  SEED_WORKSPACE_USER_ID,
  UPDATE_EVENT_TYPES,
  UPDATE_PHASES
} from './constants.js';
export {
  GLOBAL_DATA_DIR_NAME,
  GLOBAL_DATABASE_FILENAME,
  LOCAL_DATA_DIR,
  LOCAL_STORAGE_BUCKET_PATHS,
  LOCAL_STORAGE_DIR,
  resolveGlobalDatabasePath,
  resolveGlobalDataDir
} from './local-paths.js';
export { listPostgresMigrationFiles, migratePostgres } from './migrate-postgres.js';
export {
  applyHostedS3StorageBackend,
  type HostedS3SeedResult,
  resolveHostedS3SettingsFromEnv,
  type S3BucketSettings
} from './storage-seed.js';
