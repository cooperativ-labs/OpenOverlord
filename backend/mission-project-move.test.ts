import {
  createPostgresSessionClient,
  createSqliteClient,
  migratePostgres
} from '@overlord/database';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { bindWebappDatabaseClient, bootstrapIntegrationTestDb } from './test-helpers.ts';

/**
 * Adapter conformance for cross-project mission moves on the hosted-backend
 * Postgres path.
 *
 * The same battery runs against SQLite (always) and PostgreSQL (when
 * `TEST_DATABASE_URL` points at a reachable Postgres). Postgres must defer the
 * objectives `(project_id, mission_id)` FK so denormalized rows can repoint
 * before the mission row in one transaction.
 */

interface AdapterHandle {
  teardown: () => Promise<void>;
}

interface AdapterFactory {
  label: string;
  create: () => Promise<AdapterHandle>;
}

const sqliteFactory: AdapterFactory = {
  label: 'sqlite',
  create: async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-project-move-'));
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    return { teardown: async () => {} };
  }
};

function postgresFactory(connectionString: string): AdapterFactory {
  return {
    label: 'postgres',
    create: async () => {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const schema = `ovld_move_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);

      const scoped = new Pool({ connectionString });
      const session = await scoped.connect();
      await session.query(`SET search_path TO ${schema}`);
      const client = createPostgresSessionClient(session);
      await migratePostgres(client);
      await bindWebappDatabaseClient({ client });

      return {
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

async function runMissionProjectMoveCase(): Promise<void> {
  const { createProject, createMission, updateMission, getMissionDetail } =
    await import('./repository.ts');

  const p1 = await createProject({ name: 'Project A' });
  const p2 = await createProject({ name: 'Project B' });
  const mission = await createMission({ projectId: p1.id, firstObjective: 'Move me' });
  assert.equal(mission.projectId, p1.id);

  const updated = await updateMission(mission.id, { projectId: p2.id });
  assert.equal(updated.projectId, p2.id);

  const detail = await getMissionDetail(mission.id);
  assert.equal(detail.projectId, p2.id);
  assert.equal(detail.objectives.length, 1);
  assert.equal(detail.objectives[0]?.projectId, p2.id);
}

for (const adapter of adapters) {
  describe(`mission project move [${adapter.label}]`, () => {
    it('updates mission project_id via updateMission', async () => {
      const { teardown } = await adapter.create();
      try {
        await runMissionProjectMoveCase();
      } finally {
        await teardown();
      }
    });
  });
}

after(() => {
  if (!process.env.TEST_DATABASE_URL) {
    console.warn(
      '[mission project move postgres-conformance] TEST_DATABASE_URL not set — Postgres battery skipped; SQLite battery ran.'
    );
  }
});
