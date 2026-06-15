import { loadConfig, resolveDatabasePath } from '../cli/src/config.ts';

/**
 * Print the absolute path of the SQLite database this instance resolves to,
 * honouring `OVERLORD_SQLITE_PATH`, the `overlord.toml` `database_path`
 * override, and otherwise the per-user global default (`~/.ovld/...`).
 *
 * Used by the `db:start` / `db:codegen` package scripts so the launcher and the
 * Kysely type generator always target the same file no matter where the
 * database lives. Written without a trailing newline so it can be captured
 * directly via shell command substitution (`$(tsx scripts/print-db-path.ts)`).
 */
process.stdout.write(resolveDatabasePath(loadConfig()));
