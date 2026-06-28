import { migratePostgres, openDatabaseClient, resolveAdapter } from '@overlord/database';

/**
 * Apply the bundled PostgreSQL migrations against the hosted database.
 *
 * Resolves the adapter exactly like the backend (`resolveAdapter()` — the
 * `overlord.toml` `database_url` admin setting or the `DATABASE_URL` environment
 * variable), refuses to run unless that selects Postgres, then runs the
 * idempotent migration runner. Use this to bootstrap or upgrade the Neon
 * (or any Postgres) control-plane database:
 *
 *   DATABASE_URL=postgresql://… tsx scripts/migrate-postgres.ts
 *
 * Set `OVERLORD_PG_SCHEMA` to target a non-default schema.
 */
async function main(): Promise<void> {
  const adapter = resolveAdapter();
  if (adapter.type !== 'postgres') {
    console.error(
      'migrate-postgres: no Postgres connection resolved. Set DATABASE_URL (or the ' +
        'overlord.toml database_url) to a postgres:// connection string.'
    );
    process.exit(1);
  }

  const redacted = adapter.connectionString.replace(/:\/\/[^@]*@/, '://***@');
  console.error(`migrate-postgres: applying migrations to ${redacted}`);
  warnIfRailwayPrivateUrl(adapter.connectionString);

  const client = await openDatabaseClient(adapter);
  try {
    await migratePostgres(client);
    console.error('migrate-postgres: migrations applied.');
  } finally {
    await client.close();
  }
}

function warnIfRailwayPrivateUrl(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return;
  }

  if (!host.endsWith('.railway.internal')) return;

  console.error(
    [
      'migrate-postgres: Railway private database hosts (*.railway.internal) only resolve inside Railway.',
      'Run this command inside Railway with DATABASE_PUBLIC_URL, or override DATABASE_URL locally with',
      'the Railway Postgres public proxy URL just for the migration command.',
      '',
      'Example:',
      '  railway run --service <postgres-service-id> --no-local -- sh -c',
      '    \'DATABASE_URL="$DATABASE_PUBLIC_URL" yarn db:migrate:postgres\''
    ].join('\n')
  );
  process.exit(1);
}

main().catch(error => {
  console.error('migrate-postgres: failed —', error instanceof Error ? error.message : error);
  process.exit(1);
});
