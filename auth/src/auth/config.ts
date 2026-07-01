import { type AdapterConfig, loadBetterSqlite3, resolveAdapter } from '@overlord/database';
import { betterAuth, type User } from 'better-auth';
import { bearer } from 'better-auth/plugins';
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
  /**
   * Called from the `deleteUser` `beforeDelete` hook with the Better Auth
   * user id (`profiles.id`) before the user row — and everything that
   * hard-cascades from it — is removed. The caller is responsible for
   * clearing any `ON DELETE RESTRICT` children first; see
   * `backend/account-deletion.ts`. Self-service account deletion
   * (`user.deleteUser`) is enabled only when this is provided.
   */
  onDeleteUser?: (userId: string) => Promise<void>;
  /**
   * Delivers the sign-up/sign-in verification email (backend-supplied, e.g.
   * Resend-backed — see `backend/email-verification.ts`). Sign-up/sign-in
   * email verification is enabled only when this is provided; when omitted,
   * accounts are never email-verified, matching prior behavior (the default
   * for offline/local editions with no configured email-sending provider).
   */
  sendVerificationEmail?: (params: { user: User; url: string; token: string }) => Promise<void>;
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
    const Database = loadBetterSqlite3();
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
    // `requireEmailVerification` also gates sign-in for unverified accounts,
    // so it must only be enabled alongside a real `sendVerificationEmail`
    // sender — otherwise every sign-in would be rejected with no way to
    // (re)send the verification email that would unblock it.
    emailAndPassword: {
      enabled: true,
      ...(options.sendVerificationEmail ? { requireEmailVerification: true } : {})
    },
    ...(options.sendVerificationEmail
      ? {
          emailVerification: {
            sendVerificationEmail: async ({
              user,
              url,
              token
            }: {
              user: User;
              url: string;
              token: string;
            }) => options.sendVerificationEmail!({ user, url, token }),
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true
          }
        }
      : {}),
    // Email is the primary account identifier. Changing email applies
    // immediately without re-verifying the new address (the account is
    // already authenticated for the change), independent of sign-up/sign-in
    // verification above.
    user: {
      changeEmail: { enabled: true },
      ...(options.onDeleteUser
        ? {
            deleteUser: {
              enabled: true,
              beforeDelete: async (user: User) => {
                await options.onDeleteUser!(user.id);
              }
            }
          }
        : {})
    },
    plugins: [bearer()]
  });
}

export type Auth = ReturnType<typeof createAuth>;
