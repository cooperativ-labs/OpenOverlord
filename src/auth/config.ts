import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';

/**
 * Create a Better Auth instance backed by the SQLite database at dbPath.
 *
 * The bearer plugin converts Authorization: Bearer <session_token> headers into
 * session cookies so that programmatic HTTP clients can use session tokens.
 */
export function createAuth(dbPath: string) {
  return betterAuth({
    // better-sqlite3 satisfies the runtime SqliteDatabase contract; the "as any"
    // works around a TypeScript structural mismatch on Statement.all signatures.
    database: new Database(dbPath) as any,
    emailAndPassword: { enabled: true },
    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
