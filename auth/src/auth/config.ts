import { type AdapterConfig, resolveAdapter } from '@overlord/database';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/**
 * Better Auth database configuration.
 *
 * SQLite remains useful for local development, but shared/private-network
 * deployments should use PostgreSQL so auth sessions coordinate with the same
 * authoritative database as the rest of Overlord.
 */
export type AuthDatabaseConfig =
  | {
      type: 'sqlite';
      path: string;
    }
  | {
      type: 'postgres';
      connectionString?: string;
      pool?: Pool;
      schema?: string;
    };

export interface CreateAuthOptions {
  database: AuthDatabaseConfig;
  /** Origins allowed to call Better Auth (e.g. the Vite dev server in split-port dev). */
  trustedOrigins?: string[];
}

function postgresSearchPath(schema: string | undefined): string | undefined {
  if (!schema) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('PostgreSQL schema must be a simple identifier');
  }
  return `-c search_path=${schema},public`;
}

function createBetterAuthDatabase(config: AuthDatabaseConfig) {
  if (config.type === 'sqlite') {
    // better-sqlite3 satisfies the runtime SqliteDatabase contract; the "as any"
    // works around a TypeScript structural mismatch on Statement.all signatures.
    return new Database(config.path) as any;
  }

  const pool =
    config.pool ??
    new Pool({
      connectionString: config.connectionString ?? process.env.DATABASE_URL,
      options: postgresSearchPath(config.schema)
    });

  return {
    db: new Kysely({ dialect: new PostgresDialect({ pool }) }),
    type: 'postgres' as const
  };
}

/** Map the repo-wide `resolveAdapter()` result onto Better Auth's database config. */
function authDatabaseFromAdapter(adapter: AdapterConfig): AuthDatabaseConfig {
  if (adapter.type === 'sqlite') {
    return { type: 'sqlite', path: adapter.path };
  }
  return adapter.schema
    ? { type: 'postgres', connectionString: adapter.connectionString, schema: adapter.schema }
    : { type: 'postgres', connectionString: adapter.connectionString };
}

/**
 * Create a Better Auth instance backed by SQLite or PostgreSQL.
 *
 * Called with no argument, the database is chosen by the single repo-wide
 * `resolveAdapter()` so auth coordinates with the same adapter the rest of the
 * service layer uses, instead of independently sniffing `DATABASE_URL`. A string
 * still selects SQLite at that path, and an explicit options object overrides
 * the selection entirely.
 *
 * The bearer plugin converts Authorization: Bearer <session_token> headers into
 * session cookies so that programmatic HTTP clients can use session tokens.
 */
export function createAuth(dbPathOrOptions?: string | CreateAuthOptions) {
  const options =
    dbPathOrOptions === undefined
      ? { database: authDatabaseFromAdapter(resolveAdapter()) }
      : typeof dbPathOrOptions === 'string'
        ? { database: { type: 'sqlite' as const, path: dbPathOrOptions } }
        : dbPathOrOptions;

  return betterAuth({
    database: createBetterAuthDatabase(options.database),
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    emailAndPassword: { enabled: true },
    // The account username is the local-part of the synthetic
    // `<username>@overlord.local` sign-in email, so changing the username means
    // changing the account email. Local accounts are never email-verified, so
    // Better Auth applies the change directly without a verification round-trip.
    user: { changeEmail: { enabled: true } },
    plugins: [bearer()]
  });
}

export type Auth = ReturnType<typeof createAuth>;
