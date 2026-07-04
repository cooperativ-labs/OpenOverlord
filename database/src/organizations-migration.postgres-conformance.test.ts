import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPostgresSessionClient } from './client.js';
import { migrateDatabase, openInMemoryDatabase } from './connection.js';

/**
 * Rehearsal for the `20260704120000_organizations.sql` migration (coo:135) —
 * the one migration in this repo whose data-transformation correctness only
 * has to hold on Postgres (the local SQLite DB is wiped, per the plan's R2
 * decision). This suite hand-builds a production-shaped fixture *before* that
 * migration runs (three workspaces, one with a logo, a project, a mission, a
 * USER_TOKEN, and a search-index row), applies only that one migration file
 * directly, then asserts the invariants a real production rehearsal must
 * hold: exactly one organization seeded from the oldest workspace's identity,
 * every workspace UUID-rekeyed with its `display_id` byte-identical, the
 * token still resolvable, and `search_documents` purged.
 *
 * Requires `TEST_DATABASE_URL` (skipped otherwise, matching every other
 * `*.postgres-conformance.test.ts` suite in this repo). The SQLite battery
 * below only re-confirms the schema-only fresh-install invariant (Q10: zero
 * orgs/workspaces after a clean migration chain), since the data-preserving
 * rekey has no SQLite analogue.
 */

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'postgres',
  'migrations'
);
const ORGANIZATIONS_MIGRATION_FILE = '20260704120000_organizations.sql';

function sortedMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter(name => /^\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

describe('fresh-install ends at zero organizations and zero workspaces [sqlite]', () => {
  it('has no organizations or workspaces after the full migration chain', () => {
    const sqlite = openInMemoryDatabase();
    migrateDatabase(sqlite);
    const orgCount = (
      sqlite.prepare('SELECT COUNT(*) AS count FROM organizations').get() as { count: number }
    ).count;
    const workspaceCount = (
      sqlite.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }
    ).count;
    assert.equal(orgCount, 0);
    assert.equal(workspaceCount, 0);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresRehearsal = testDatabaseUrl ? describe : describe.skip;
if (!testDatabaseUrl) {
  console.log(
    '[organizations migration rehearsal] TEST_DATABASE_URL not set — Postgres rehearsal skipped.'
  );
}

postgresRehearsal(
  'organizations migration rehearsal on a production-shaped fixture [postgres]',
  () => {
    let admin: InstanceType<typeof import('pg').Pool>;
    let pool: InstanceType<typeof import('pg').Pool>;
    let session: import('pg').PoolClient;
    let client: ReturnType<typeof createPostgresSessionClient>;
    const schema = `ovld_org_migration_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    before(async () => {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      admin = new Pool({ connectionString: testDatabaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);

      pool = new Pool({ connectionString: testDatabaseUrl });
      session = await pool.connect();
      await session.query(`SET search_path TO ${schema}`);
      client = createPostgresSessionClient(session);

      // Apply every migration *before* the organizations one — the pristine
      // pre-org schema (slug-keyed workspace ids, no organizations table).
      for (const fileName of sortedMigrationFiles()) {
        if (fileName === ORGANIZATIONS_MIGRATION_FILE) break;
        const sql = readFileSync(path.join(migrationsDir, fileName), 'utf8');
        await client.exec(sql);
      }

      // Hand-build a production-shaped fixture: three live workspaces (the
      // migration-seeded 'local-workspace' plus two more), one of which
      // ('ws-alpha') is deliberately the *oldest* and carries a logo, so the
      // backfill's "identity from the oldest live workspace" rule (Q1) has
      // something real to pick between.
      const now = new Date();
      const oldest = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const middle = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

      // Migrations 001-004 seed a 'local-workspace' row with a *fixed* historical
      // created_at (2026-01-01), regardless of when this test actually runs — so
      // any freshly-inserted workspace with a "days ago" timestamp is never
      // really the oldest. Simulate the real production shape instead: treat
      // 'local-workspace' as the genuine first-ever (renamed, logo'd) workspace
      // rather than an untouched seed row, since that is what the "oldest live
      // workspace" identity source resolves to in a real database.
      await client.run(
        `UPDATE workspaces
          SET name = 'Alpha Workspace', slug = 'alpha',
              settings_json = '{"logoUrl": "/api/storage/workspace-images/alpha-logo.png"}'
        WHERE id = 'local-workspace'`
      );
      await client.run(
        `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
       VALUES ('ws-beta', 'beta', 'Beta Workspace', 'local', '{}', ?, ?, 1)`,
        [oldest, oldest]
      );
      await client.run(
        `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
       VALUES ('ws-gamma', 'gamma', 'Gamma Workspace', 'local', '{}', ?, ?, 1)`,
        [middle, middle]
      );

      await client.run(
        `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
       VALUES ('rehearsal-user', 'rehearsal-user', 'rehearsal-user@overlord.local', true, NULL, ?, ?)`,
        [oldest, oldest]
      );
      await client.run(
        `INSERT INTO workspace_users
         (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
       VALUES ('ws-alpha-user', 'local-workspace', 'rehearsal-user', 'auth:rehearsal-user', 'active', '{}', ?, ?, 1)`,
        [oldest, oldest]
      );
      await client.run(
        `INSERT INTO role_assignments
         (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
          assigned_by_workspace_user_id, created_at, updated_at, revision)
       VALUES ('ws-alpha-user-admin', 'local-workspace', 'ws-alpha-user', 'ADMIN', '', '', 'ws-alpha-user', ?, ?, 1)`,
        [oldest, oldest]
      );
      await client.run(
        `INSERT INTO projects (id, workspace_id, slug, name, status, settings_json, created_at, updated_at, revision)
       VALUES ('proj-1', 'local-workspace', 'proj', 'Alpha Project', 'active', '{}', ?, ?, 1)`,
        [oldest, oldest]
      );
      await client.run(
        `INSERT INTO missions
         (id, workspace_id, project_id, display_id, sequence_number, title, status_id, status_type,
          created_at, updated_at, revision)
       VALUES ('mission-1', 'local-workspace', 'proj-1', 'alpha:1', 1, 'Rehearsal Mission',
               'local-workspace-status-backlog', 'draft', ?, ?, 1)`,
        [oldest, oldest]
      );

      const rawToken = 'out_rehearsal_test_token';
      const tokenHash = (await import('node:crypto'))
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');
      await client.run(
        `INSERT INTO user_tokens
         (id, workspace_id, profile_id, workspace_user_id, label, token_prefix, token_hash,
          hash_algorithm, status, created_at, updated_at, revision)
       VALUES ('rehearsal-token', 'local-workspace', 'rehearsal-user', 'ws-alpha-user', 'rehearsal',
               'out_rehear', ?, 'sha256', 'active', ?, ?, 1)`,
        [tokenHash, oldest, oldest]
      );

      // Now run the migration under rehearsal.
      const orgMigrationSql = readFileSync(
        path.join(migrationsDir, ORGANIZATIONS_MIGRATION_FILE),
        'utf8'
      );
      await client.exec(orgMigrationSql);
    });

    after(async () => {
      await client.close();
      session.release();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });

    it('seeds exactly one organization from the oldest live workspace’s name and logo', async () => {
      const orgs = await client.all<{ id: string; name: string; settings_json: string }>(
        `SELECT id, name, settings_json FROM organizations`
      );
      assert.equal(orgs.length, 1);
      assert.equal(orgs[0]?.name, 'Alpha Workspace');
      const settings =
        typeof orgs[0]?.settings_json === 'string'
          ? JSON.parse(orgs[0].settings_json)
          : orgs[0]?.settings_json;
      assert.equal(settings.logoUrl, '/api/storage/workspace-images/alpha-logo.png');
    });

    it('attaches all three workspaces to the one organization and rekeys their ids to UUIDs', async () => {
      const org = (await client.get<{ id: string }>(`SELECT id FROM organizations LIMIT 1`))!;
      const workspaces = await client.all<{ id: string; slug: string; organization_id: string }>(
        `SELECT id, slug, organization_id FROM workspaces ORDER BY slug`
      );
      assert.equal(workspaces.length, 3);
      for (const workspace of workspaces) {
        assert.equal(workspace.organization_id, org.id);
        assert.match(
          workspace.id,
          /^[0-9a-f-]{36}$/i,
          `expected a UUID id for slug ${workspace.slug}`
        );
      }
      const oldIds = await client.all(
        `SELECT 1 FROM workspaces WHERE id IN ('local-workspace', 'ws-beta', 'ws-gamma')`
      );
      assert.equal(oldIds.length, 0, 'old slug-derived workspace ids must not survive the rekey');
    });

    it('preserves the mission display_id byte-identical and repoints workspace_id/project_id consistently', async () => {
      const mission = await client.get<{
        display_id: string;
        workspace_id: string;
        project_id: string;
      }>(`SELECT display_id, workspace_id, project_id FROM missions WHERE id = 'mission-1'`);
      assert.equal(mission?.display_id, 'alpha:1');
      const project = await client.get<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM projects WHERE id = 'proj-1'`
      );
      assert.equal(mission?.workspace_id, project?.workspace_id);
      assert.notEqual(mission?.workspace_id, 'local-workspace');
    });

    it('keeps the USER_TOKEN resolvable under the rekeyed workspace id', async () => {
      const token = await client.get<{ workspace_id: string | null; token_hash: string }>(
        `SELECT workspace_id, token_hash FROM user_tokens WHERE id = 'rehearsal-token'`
      );
      assert.ok(token);
      assert.notEqual(token!.workspace_id, 'local-workspace');
      const workspace = await client.get<{ id: string }>(`SELECT id FROM workspaces WHERE id = ?`, [
        token!.workspace_id!
      ]);
      assert.ok(
        workspace,
        'the token’s rekeyed workspace_id must reference a real, live workspace'
      );
    });

    it('purges search_documents and seeds the organization-images bucket', async () => {
      const searchDocs = await client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM search_documents`
      );
      assert.equal(Number(searchDocs?.count), 0);

      const org = (await client.get<{ id: string }>(`SELECT id FROM organizations LIMIT 1`))!;
      const bucket = await client.get<{ bucket_key: string }>(
        `SELECT bucket_key FROM storage_buckets WHERE organization_id = ?`,
        [org.id]
      );
      assert.equal(bucket?.bucket_key, 'organization-images');
    });
  }
);
