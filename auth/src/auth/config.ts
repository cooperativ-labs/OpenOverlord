import { type AdapterConfig, loadBetterSqlite3, resolveAdapter } from '@overlord/database';
import { betterAuth, type User } from 'better-auth';
import { bearer, emailOTP } from 'better-auth/plugins';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/**
 * The transactional-email OTP flows Better Auth's `emailOTP` plugin can drive.
 * `email-verification` is minted alongside the sign-up confirmation link so the
 * same email carries both a clickable link and a typed 6-digit code; the others
 * back the passwordless sign-in and password-reset surfaces.
 */
export type EmailOTPType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

/** How long an emailed OTP stays valid — matches the "expires in 1 hour" email copy. */
const EMAIL_OTP_EXPIRES_IN_SECONDS = 60 * 60;
/** Numeric OTP length; the code block in the email templates is styled for six digits. */
const EMAIL_OTP_LENGTH = 6;

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
  sendVerificationEmail?: (params: {
    user: User;
    url: string;
    token: string;
    /**
     * Real 6-digit OTP minted alongside the verification link (see
     * `emailOTP` plugin below). Present only when `sendEmailOTP` is also
     * configured; the sender shows this in the email's "OR USE CODE" block
     * instead of the long, untypable verification `token`.
     */
    otp?: string;
  }) => Promise<void>;
  /**
   * Delivers a standalone one-time code for the `emailOTP` plugin's own flows
   * (passwordless sign-in and password reset), backend-supplied the same way as
   * `sendVerificationEmail`. When provided, the `emailOTP` plugin is enabled so
   * numeric OTPs are generated and verifiable via `/api/auth/email-otp/*`; when
   * omitted, the plugin is left off and behavior is unchanged. Sign-up
   * confirmation continues to flow through `sendVerificationEmail` (which then
   * also carries a minted `otp`), so this callback fires only for the
   * sign-in / forget-password code emails.
   */
  sendEmailOTP?: (params: { email: string; otp: string; type: EmailOTPType }) => Promise<void>;
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

  // The `emailVerification.sendVerificationEmail` wrapper needs to call back
  // into the constructed instance (`auth.api.createVerificationOTP`) to mint the
  // OTP shown beside the link. Better Auth runs that callback only at request
  // time — long after construction — so a mutable holder safely breaks the
  // otherwise-circular reference to `auth`.
  let authInstance: Auth | undefined;

  const otpEnabled = Boolean(options.sendEmailOTP);

  /**
   * Mint a real 6-digit OTP for `email` tied to the sign-up verification flow,
   * stored by the `emailOTP` plugin and verifiable via `/email-otp/verify-email`.
   * Returns `undefined` when the plugin is disabled or minting fails, so the
   * verification email still sends (just without a usable code) rather than
   * blocking sign-up.
   */
  async function mintEmailVerificationOTP(email: string): Promise<string | undefined> {
    if (!otpEnabled || !authInstance) return undefined;
    try {
      return await authInstance.api.createVerificationOTP({
        body: { email, type: 'email-verification' }
      });
    } catch {
      return undefined;
    }
  }

  const auth = betterAuth({
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
            }) => {
              const otp = await mintEmailVerificationOTP(user.email);
              await options.sendVerificationEmail!({
                user,
                url,
                token,
                ...(otp ? { otp } : {})
              });
            },
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
    plugins: [
      bearer(),
      ...(options.sendEmailOTP
        ? [
            emailOTP({
              otpLength: EMAIL_OTP_LENGTH,
              expiresIn: EMAIL_OTP_EXPIRES_IN_SECONDS,
              sendVerificationOTP: async ({ email, otp, type }) => {
                await options.sendEmailOTP!({ email, otp, type });
              }
            })
          ]
        : [])
    ]
  });

  authInstance = auth;
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
