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

/**
 * Create a Better Auth instance backed by SQLite or PostgreSQL.
 *
 * The bearer plugin converts Authorization: Bearer <session_token> headers into
 * session cookies so that programmatic HTTP clients can use session tokens.
 */
export function createAuth(dbPathOrOptions: string | CreateAuthOptions) {
  const options =
    typeof dbPathOrOptions === 'string'
      ? { database: { type: 'sqlite' as const, path: dbPathOrOptions } }
      : dbPathOrOptions;

  return betterAuth({
    database: createBetterAuthDatabase(options.database),
    emailAndPassword: { enabled: true },
    plugins: [bearer()]
  });
}

export type Auth = ReturnType<typeof createAuth>;
