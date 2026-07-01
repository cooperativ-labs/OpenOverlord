import { cascadeDeleteAccount } from '../backend/account-deletion.ts';
import { initDatabase } from '../backend/db.ts';

/**
 * Permanently delete a user identity directly against the database — the
 * admin equivalent of the self-service "Delete my account" flow, for use when
 * there is no session to drive Better Auth's `deleteUser` (e.g. removing
 * another user from the Railway/production database).
 *
 * Deleting the `"user"` row by hand (e.g. from the Railway Postgres dashboard)
 * fails with a `RESTRICT` foreign key violation on `workspace_users` (and,
 * once that is cleared, `user_tokens` / `user_images`) — see
 * `backend/account-deletion.ts` for why. This script runs the same purge
 * cascade before deleting the row, then lets the existing `ON DELETE CASCADE`
 * FKs remove `session`, `account`, `profiles`, and
 * `user_execution_target_preferences`.
 *
 * Usage:
 *   tsx scripts/delete-user.ts <user-id-or-email> --yes
 *   DATABASE_URL=postgresql://… node scripts/with-prod-env.mjs tsx scripts/delete-user.ts <user-id-or-email> --yes
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const identifier = args.find(arg => !arg.startsWith('--'));

  if (!identifier) {
    console.error('usage: delete-user.ts <user-id-or-email> --yes');
    process.exit(2);
  }

  const client = await initDatabase();
  try {
    const isEmail = identifier.includes('@');
    const user = await client.get<{ id: string; email: string }>(
      `SELECT id, email FROM "user" WHERE ${isEmail ? '"email"' : '"id"'} = ?`,
      [identifier]
    );
    if (!user) {
      console.error(`delete-user: no user found for '${identifier}'`);
      process.exit(1);
    }

    const workspaceCount = (
      await client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_users WHERE profile_id = ?`,
        [user.id]
      )
    )?.count;
    const tokenCount = (
      await client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM user_tokens WHERE profile_id = ?`,
        [user.id]
      )
    )?.count;
    const imageCount = (
      await client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM user_images WHERE profile_id = ?`,
        [user.id]
      )
    )?.count;

    console.error(
      `delete-user: ${user.email} (${user.id}) — ${workspaceCount} workspace membership(s), ` +
        `${tokenCount} token(s), ${imageCount} image(s) will be permanently purged, then the ` +
        `account itself. This cannot be undone.`
    );
    if (!confirmed) {
      console.error('delete-user: pass --yes to confirm.');
      process.exit(1);
    }

    await cascadeDeleteAccount(user.id);
    await client.run(`DELETE FROM "user" WHERE id = ?`, [user.id]);
    console.error(`delete-user: ${user.email} (${user.id}) deleted.`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('delete-user: failed —', error instanceof Error ? error.message : error);
  process.exit(1);
});
