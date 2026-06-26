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

  const client = await openDatabaseClient(adapter);
  try {
    await migratePostgres(client);
    console.error('migrate-postgres: migrations applied.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('migrate-postgres: failed —', error instanceof Error ? error.message : error);
  process.exit(1);
});
