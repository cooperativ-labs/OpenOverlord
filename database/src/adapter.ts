import { resolveDefaultDatabasePath } from './connection.js';

/**
 * The single adapter-selection point for the whole repo.
 *
 * Before this existed, the CLI runtime always opened SQLite at the configured
 * path while `auth/src/auth/config.ts` independently sniffed `DATABASE_URL` to decide
 * between SQLite and PostgreSQL. That meant auth and the rest of the service
 * layer could disagree about which database is authoritative. `resolveAdapter()`
 * makes that decision once: a PostgreSQL connection string in `DATABASE_URL`
 * selects Postgres; otherwise we use local SQLite at the resolved path.
 */
export type AdapterConfig =
  | { type: 'sqlite'; path: string }
  | { type: 'postgres'; connectionString: string; schema?: string };

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//i;

export function resolveAdapter(
  options: { databasePath?: string; startDir?: string } = {}
): AdapterConfig {
  const url = process.env.DATABASE_URL?.trim();
  if (url && POSTGRES_URL_PATTERN.test(url)) {
    const schema = process.env.OVERLORD_PG_SCHEMA?.trim();
    return schema
      ? { type: 'postgres', connectionString: url, schema }
      : { type: 'postgres', connectionString: url };
  }

  return {
    type: 'sqlite',
    path: options.databasePath ?? resolveDefaultDatabasePath(options.startDir)
  };
}
