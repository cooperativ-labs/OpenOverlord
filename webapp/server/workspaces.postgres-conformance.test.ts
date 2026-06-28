import {
  createPostgresSessionClient,
  createSqliteClient,
  migrateDatabase,
  migratePostgres,
  openInMemoryDatabase
} from '@overlord/database';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { bindWebappDatabaseClient } from './test-helpers.ts';

/**
 * Adapter conformance for workspace creation on the hosted-backend Postgres path.
 *
 * The same battery runs against SQLite (always) and PostgreSQL (when
 * `TEST_DATABASE_URL` points at a reachable Postgres). It pins the nullable
 * exclude-parameter queries that Postgres cannot type-infer during
 * `createWorkspace` and `completeInitialSetup`.
 */

interface AdapterHandle {
  client: ReturnType<typeof createSqliteClient>;
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
    await bindWebappDatabaseClient({ client });
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
      const schema = `ovld_ws_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);

      const scoped = new Pool({ connectionString });
      const session = await scoped.connect();
      await session.query(`SET search_path TO ${schema}`);
      const client = createPostgresSessionClient(session);
      await migratePostgres(client);
      await bindWebappDatabaseClient({ client });

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

for (const adapter of adapters) {
  describe(`createWorkspace conformance [${adapter.label}]`, () => {
    it('creates a workspace without nullable exclude parameters', async () => {
      const { teardown } = await adapter.create();
      try {
        const { createWorkspace } = await import('./workspaces.ts');
        const created = await createWorkspace({ name: 'Conformance Workspace' });

        assert.equal(created.name, 'Conformance Workspace');
        assert.equal(created.id, 'conformance-workspace');
        assert.ok(created.slug.length > 0);
        assert.equal(created.isActive, true);
      } finally {
        await teardown();
      }
    });

    it('rejects duplicate workspace IDs', async () => {
      const { teardown } = await adapter.create();
      try {
        const { createWorkspace } = await import('./workspaces.ts');

        await createWorkspace({ id: 'engineering-hq', name: 'Engineering HQ' });
        await assert.rejects(
          async () => await createWorkspace({ id: 'engineering-hq', name: 'Duplicate HQ' }),
          /already exists/
        );
      } finally {
        await teardown();
      }
    });

    it('completes initial setup using excludeWorkspaceId slug/id checks', async () => {
      const { teardown } = await adapter.create();
      try {
        const { completeInitialSetup, needsInitialSetup } = await import('./workspaces.ts');
        const dbModule = await import('./db.ts');

        assert.equal(await needsInitialSetup(), true);

        const updated = await completeInitialSetup({
          id: 'acme-operations',
          name: 'Acme Operations',
          slug: 'aco'
        });

        assert.equal(updated.id, 'acme-operations');
        assert.equal(updated.slug, 'aco');
        assert.equal(await needsInitialSetup(), false);
        assert.equal(dbModule.WORKSPACE.id, 'acme-operations');
      } finally {
        await teardown();
      }
    });

    it('rekeys initial setup with an attached agent session graph', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const { createMission, createProject } = await import('./repository.ts');
        const { completeInitialSetup } = await import('./workspaces.ts');

        const project = await createProject({ name: 'Session Rekey Project' });
        const mission = await createMission({
          projectId: project.id,
          title: 'Session Rekey Mission',
          objectives: [{ objective: 'Keep the agent session attached' }]
        });
        const objective = await client.get<{ id: string }>(
          `SELECT id FROM objectives WHERE mission_id = ? AND workspace_id = ? LIMIT 1`,
          [mission.id, 'local-workspace']
        );
        assert.ok(objective);

        const now = new Date().toISOString();
        await client.run(
          `INSERT INTO agent_sessions
             (id, workspace_id, project_id, mission_id, objective_id,
              session_key_prefix, session_key_hash, agent_identifier, connection_method,
              phase, delivery_state, started_at, metadata_json, created_at, updated_at, revision)
           VALUES (?, 'local-workspace', ?, ?, ?, ?, ?, 'codex', 'cli',
                   'execute', 'not_delivered', ?, '{}', ?, ?, 1)`,
          [
            `session_${randomUUID()}`,
            project.id,
            mission.id,
            objective.id,
            `pfx_${randomUUID().slice(0, 8)}`,
            `hash_${randomUUID()}`,
            now,
            now,
            now
          ]
        );

        const updated = await completeInitialSetup({
          id: 'session-rekey-workspace',
          name: 'Session Rekey Workspace',
          slug: 'srw'
        });

        assert.equal(updated.id, 'session-rekey-workspace');
        const staleSession = await client.get<{ id: string }>(
          `SELECT id FROM agent_sessions WHERE workspace_id = ? LIMIT 1`,
          ['local-workspace']
        );
        assert.equal(staleSession, undefined);
        const movedSession = await client.get<{ id: string }>(
          `SELECT id FROM agent_sessions WHERE workspace_id = ? LIMIT 1`,
          ['session-rekey-workspace']
        );
        assert.ok(movedSession);
      } finally {
        await teardown();
      }
    });
  });
}

after(() => {
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      '[workspaces postgres-conformance] TEST_DATABASE_URL not set — Postgres battery skipped; SQLite battery ran.'
    );
  }
});
