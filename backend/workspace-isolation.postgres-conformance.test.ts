import {
  createPostgresSessionClient,
  createSqliteClient,
  type DatabaseClient,
  migrateDatabase,
  migratePostgres,
  openInMemoryDatabase
} from '@overlord/database';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { seedAuthenticatedOperatorClient } from './test-helpers.ts';

/**
 * Conformance for Phase 1 of `planning/feature-plans/multitenancy-access-control.md`:
 * the process-global `WORKSPACE` singleton is retired in favor of per-request
 * tenant scoping (`getActiveWorkspaceId()`/`getActiveWorkspace()` backed by
 * `AsyncLocalStorage`). This proves two concurrent, interleaved requests from
 * different users each read and write only their own workspace's data — the
 * exact bug reported in `coo:94` (a second signed-up account could see every
 * ticket in the first user's workspace).
 *
 * The same battery runs against SQLite (always) and PostgreSQL (when
 * `TEST_DATABASE_URL` points at a reachable Postgres).
 */

interface AdapterHandle {
  client: DatabaseClient;
  teardown: () => Promise<void>;
}

interface AdapterFactory {
  label: string;
  create: () => Promise<AdapterHandle>;
}

const sqliteFactory: AdapterFactory = {
  label: 'sqlite',
  create: async () => {
    const sqlite = openInMemoryDatabase();
    migrateDatabase(sqlite);
    const client = createSqliteClient(sqlite);
    const dbModule = await import('./db.ts');
    await dbModule.bindDatabaseClient(client);
    return {
      client,
      teardown: async () => {
        await client.close();
      }
    };
  }
};

function postgresFactory(connectionString: string): AdapterFactory {
  return {
    label: 'postgres',
    create: async () => {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const schema = `ovld_wsiso_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);

      const scoped = new Pool({ connectionString });
      const session = await scoped.connect();
      await session.query(`SET search_path TO ${schema}`);
      const client = createPostgresSessionClient(session);
      await migratePostgres(client);
      const dbModule = await import('./db.ts');
      await dbModule.bindDatabaseClient(client);

      return {
        client,
        teardown: async () => {
          await client.close();
          session.release();
          await scoped.end();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        }
      };
    }
  };
}

const adapters: AdapterFactory[] = [sqliteFactory];
if (process.env.TEST_DATABASE_URL) {
  adapters.push(postgresFactory(process.env.TEST_DATABASE_URL));
}

interface Tenant {
  workspaceId: string;
  workspaceUserId: string;
  workspace: { id: string; slug: string; name: string; kind: string };
}

async function seedTenant(
  client: DatabaseClient,
  {
    workspaceId,
    slug,
    name,
    profileId,
    workspaceUserId
  }: { workspaceId: string; slug: string; name: string; profileId: string; workspaceUserId: string }
): Promise<Tenant> {
  const now = new Date().toISOString();
  await client.run(
    `INSERT INTO workspaces (id, slug, name, kind, settings_json, created_at, updated_at, revision)
     VALUES (?, ?, ?, 'local', '{}', ?, ?, 1)`,
    [workspaceId, slug, name, now, now]
  );
  await seedAuthenticatedOperatorClient({ client, workspaceId, profileId, workspaceUserId });
  return {
    workspaceId,
    workspaceUserId,
    workspace: { id: workspaceId, slug, name, kind: 'local' }
  };
}

for (const adapter of adapters) {
  describe(`per-request workspace isolation conformance [${adapter.label}]`, () => {
    it('two concurrent, interleaved requests from different users each read only their own workspace data', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const dbModule = await import('./db.ts');
        const { createProject, listProjects } = await import('./repository.ts');

        const tenantA = await seedTenant(client, {
          workspaceId: 'tenant-a',
          slug: 'tenant-a',
          name: 'Tenant A',
          profileId: 'user-a',
          workspaceUserId: 'tenant-a-user'
        });
        const tenantB = await seedTenant(client, {
          workspaceId: 'tenant-b',
          slug: 'tenant-b',
          name: 'Tenant B',
          profileId: 'user-b',
          workspaceUserId: 'tenant-b-user'
        });

        async function runAsTenant<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
          return dbModule.withRequestContextAsync(async () => {
            dbModule.setActiveWorkspaceContext(tenant.workspace);
            dbModule.setActiveWorkspaceUser(tenant.workspaceUserId);
            return fn();
          });
        }

        // Interleave the two tenants' work on purpose — creating, awaiting a
        // tick, then listing — so this proves AsyncLocalStorage isolation
        // holds under real concurrency, not just sequential correctness.
        const [projectsA, projectsB] = await Promise.all([
          runAsTenant(tenantA, async () => {
            await createProject({ name: 'Tenant A Project' });
            await new Promise(resolve => setTimeout(resolve, 10));
            return listProjects();
          }),
          runAsTenant(tenantB, async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            await createProject({ name: 'Tenant B Project' });
            return listProjects();
          })
        ]);

        assert.equal(projectsA.length, 1);
        assert.equal(projectsA[0].name, 'Tenant A Project');
        assert.equal(projectsB.length, 1);
        assert.equal(projectsB[0].name, 'Tenant B Project');

        // Confirm directly against the database too, independent of the
        // request-context plumbing under test: each project row landed under
        // its own workspace_id, never the other tenant's.
        const rows = await client.all<{ workspace_id: string; name: string }>(
          `SELECT workspace_id, name FROM projects ORDER BY name ASC`
        );
        assert.deepEqual(
          rows.map(r => ({ workspaceId: r.workspace_id, name: r.name })),
          [
            { workspaceId: 'tenant-a', name: 'Tenant A Project' },
            { workspaceId: 'tenant-b', name: 'Tenant B Project' }
          ]
        );
      } finally {
        await teardown();
      }
    });

    it('resolving a workspace the caller is not a member of is rejected with 403, not folded into it', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const { ensureWorkspaceUser } = await import('./auth.ts');
        const dbModule = await import('./db.ts');

        const tenantA = await seedTenant(client, {
          workspaceId: 'tenant-a-guard',
          slug: 'tenant-a-guard',
          name: 'Tenant A Guard',
          profileId: 'user-a-guard',
          workspaceUserId: 'tenant-a-guard-user'
        });
        await seedTenant(client, {
          workspaceId: 'tenant-b-guard',
          slug: 'tenant-b-guard',
          name: 'Tenant B Guard',
          profileId: 'user-b-guard',
          workspaceUserId: 'tenant-b-guard-user'
        });

        await dbModule.withRequestContextAsync(async () => {
          await assert.rejects(
            () => ensureWorkspaceUser('user-a-guard', 'tenant-b-guard'),
            (err: unknown) => (err as { status?: number }).status === 403
          );
          const membership = await ensureWorkspaceUser('user-a-guard', tenantA.workspaceId);
          assert.equal(membership?.workspace.id, 'tenant-a-guard');
        });
      } finally {
        await teardown();
      }
    });

    it("a USER_TOKEN resolves only the workspace it was issued in, never another tenant's", async () => {
      const { client, teardown } = await adapter.create();
      try {
        const { resolveUserTokenWorkspaceId, verifyUserToken } = await import('@overlord/auth');
        const dbModule = await import('./db.ts');
        const { createUserToken } = await import('./repository.ts');

        const tenantA = await seedTenant(client, {
          workspaceId: 'tenant-a-token',
          slug: 'tenant-a-token',
          name: 'Tenant A Token',
          profileId: 'user-a-token',
          workspaceUserId: 'tenant-a-token-user'
        });
        const tenantB = await seedTenant(client, {
          workspaceId: 'tenant-b-token',
          slug: 'tenant-b-token',
          name: 'Tenant B Token',
          profileId: 'user-b-token',
          workspaceUserId: 'tenant-b-token-user'
        });

        async function runAsTenant<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
          return dbModule.withRequestContextAsync(async () => {
            dbModule.setActiveWorkspaceContext(tenant.workspace);
            dbModule.setActiveWorkspaceUser(tenant.workspaceUserId);
            return fn();
          });
        }

        const tokenA = await runAsTenant(tenantA, () =>
          createUserToken({ label: 'tenant-a-token' })
        );
        const tokenB = await runAsTenant(tenantB, () =>
          createUserToken({ label: 'tenant-b-token' })
        );

        const resolvedA = await resolveUserTokenWorkspaceId(client, tokenA.secret);
        const resolvedB = await resolveUserTokenWorkspaceId(client, tokenB.secret);
        assert.equal(resolvedA, 'tenant-a-token');
        assert.equal(resolvedB, 'tenant-b-token');

        // The workspace-scoped verification (what `requireAuthenticatedSession`
        // actually calls) must also refuse a token presented against the wrong
        // workspace id, even though the token itself is valid.
        assert.equal(await verifyUserToken(client, tokenA.secret, 'tenant-b-token'), null);
        assert.ok(await verifyUserToken(client, tokenA.secret, resolvedA!));
      } finally {
        await teardown();
      }
    });
  });
}

after(() => {
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      '[workspace isolation postgres-conformance] TEST_DATABASE_URL not set — Postgres battery skipped; SQLite battery ran.'
    );
  }
});
