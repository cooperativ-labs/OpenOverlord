import {
  createPostgresSessionClient,
  createSqliteClient,
  type DatabaseClient,
  migratePostgres,
  openInMemoryDatabase,
  toPostgresPlaceholders
} from '@overlord/database';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { claimNextQueuedRequest, recoverStaleExecutionRequests } from './queue-runtime.js';
import { createServiceContext } from './context.js';
import { claimNextExecutionRequest } from './execution-requests.js';
import {
  backendHostFingerprint,
  ensureCallerDeviceTarget
} from './execution-targets.js';
import {
  getProjectExecutionTargetSelection,
  listEligibleProjectExecutionTargets
} from './project-execution-target.js';
import { findPrimaryProjectResource } from './projects.js';
import { ServiceError } from './errors.js';

/**
 * Adapter conformance for the hosted-backend runtime path (mission `coo:5`,
 * objective "Make the backend Postgres-ready for Neon").
 *
 * The same battery runs against SQLite (always) and PostgreSQL (when
 * `TEST_DATABASE_URL` points at a reachable Postgres — e.g. a Neon branch on the
 * host/CI). It pins the concerns the cloud edition depends on: the
 * `entity_changes` feed, realtime/sync reads, protocol idempotency, atomic
 * execution-request queue claiming, stale-launch recovery, and service-layer
 * transaction atomicity — proving they behave identically on both adapters.
 */

const WORKSPACE_ID = 'local-workspace';
const ISO = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

// ---- Adapter factories ---------------------------------------------------

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
    const client = createSqliteClient(openInMemoryDatabase());
    return { client, teardown: () => client.close() };
  }
};

function postgresFactory(connectionString: string): AdapterFactory {
  return {
    label: 'postgres',
    create: async () => {
      const pg = await import('pg');
      const Pool = (pg.default ?? pg).Pool;
      const schema = `ovld_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      // Each test runs in its own throwaway schema so migrations and rows never
      // collide with the shared Neon database (or with a parallel test).
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);

      // A single checked-out connection keeps search_path pinned for migrations
      // and DML. Pool round-robin ignores per-connection SET on Neon poolers.
      const scoped = new Pool({ connectionString });
      const session = await scoped.connect();
      // Isolate fully from the shared public schema — including to_regclass()
      // lookups inside migratePostgres.
      await session.query(`SET search_path TO ${schema}`);
      const client = createPostgresSessionClient(session);
      await migratePostgres(client);

      return {
        client,
        teardown: async () => {
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

// ---- Portable seed helpers ----------------------------------------------

/**
 * Insert the minimal project → mission → objective graph (plus a device and a
 * local execution target) that an execution request references. Uses only the
 * required columns so the same SQL runs on both adapters; defaulted/nullable
 * columns are omitted. Returns the ids the queue tests need.
 */
async function seedGraph(client: DatabaseClient): Promise<{
  projectId: string;
  missionId: string;
  objectiveId: string;
  executionTargetId: string;
}> {
  const now = ISO();
  const projectId = `proj_${randomUUID()}`;
  const missionId = `mission_${randomUUID()}`;
  const objectiveId = `obj_${randomUUID()}`;
  const deviceId = `dev_${randomUUID()}`;
  const executionTargetId = `tgt_${randomUUID()}`;
  const sequenceRow = await client.get<{ next_value: number }>(
    `SELECT next_value FROM mission_sequences
       WHERE workspace_id = ? AND counter_name = 'mission'`,
    [WORKSPACE_ID]
  );
  const sequenceNumber = sequenceRow?.next_value ?? 1;

  await client.run(
    `INSERT INTO projects (id, workspace_id, slug, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [projectId, WORKSPACE_ID, `slug-${projectId}`, 'Conformance Project', now, now]
  );
  await client.run(
    `INSERT INTO missions
       (id, workspace_id, project_id, display_id, sequence_number, title,
        status_id, status_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local-workspace-status-backlog', 'draft', ?, ?)`,
    [
      missionId,
      WORKSPACE_ID,
      projectId,
      `coo:test-${missionId.slice(-6)}`,
      sequenceNumber,
      'Conformance Mission',
      now,
      now
    ]
  );
  await client.run(
    `INSERT INTO objectives
       (id, workspace_id, project_id, mission_id, position, title, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 'draft', ?, ?)`,
    [objectiveId, WORKSPACE_ID, projectId, missionId, 'Conformance Objective', now, now]
  );
  await client.run(
    `INSERT INTO devices (id, workspace_id, fingerprint, label, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [deviceId, WORKSPACE_ID, `fp-${deviceId}`, 'Conformance Device', now, now]
  );
  await client.run(
    `INSERT INTO execution_targets
       (id, workspace_id, device_id, type, label, status, created_at, updated_at)
     VALUES (?, ?, ?, 'local', ?, 'active', ?, ?)`,
    [executionTargetId, WORKSPACE_ID, deviceId, 'Conformance Target', now, now]
  );

  return { projectId, missionId, objectiveId, executionTargetId };
}

async function insertQueuedRequest(
  client: DatabaseClient,
  graph: Awaited<ReturnType<typeof seedGraph>>,
  options: { idempotencyKey?: string | null; createdAt?: string } = {}
): Promise<string> {
  const id = `req_${randomUUID()}`;
  const now = options.createdAt ?? ISO();
  await client.run(
    `INSERT INTO execution_requests
       (id, workspace_id, project_id, mission_id, objective_id,
        launch_mode, target_kind, requested_source, idempotency_key, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'run', 'local', 'webapp', ?, 'queued', ?, ?)`,
    [
      id,
      WORKSPACE_ID,
      graph.projectId,
      graph.missionId,
      graph.objectiveId,
      options.idempotencyKey ?? null,
      now,
      now
    ]
  );
  return id;
}

async function appendChange(
  client: DatabaseClient,
  input: { entityType: string; entityId: string; operation: string }
): Promise<void> {
  await client.run(
    `INSERT INTO entity_changes
       (id, workspace_id, entity_type, entity_id, operation, changed_fields_json, source, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, 'webapp', ?)`,
    [randomUUID(), WORKSPACE_ID, input.entityType, input.entityId, input.operation, '[]', ISO()]
  );
}

// ---- Dialect-independent unit checks -------------------------------------

describe('toPostgresPlaceholders', () => {
  it('rewrites positional placeholders to $n', () => {
    assert.equal(
      toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
      'SELECT * FROM t WHERE a = $1 AND b = $2'
    );
  });

  it('leaves ? inside string literals untouched', () => {
    assert.equal(
      toPostgresPlaceholders(`SELECT '? literal' AS q WHERE a = ?`),
      `SELECT '? literal' AS q WHERE a = $1`
    );
  });
});

// ---- Per-adapter conformance battery -------------------------------------

for (const adapter of adapters) {
  describe(`backend runtime conformance [${adapter.label}]`, () => {
    it('appends entity_changes and reads them back in seq order (realtime/sync)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        await appendChange(client, { entityType: 'mission', entityId: 'm1', operation: 'insert' });
        await appendChange(client, { entityType: 'mission', entityId: 'm1', operation: 'update' });
        await appendChange(client, {
          entityType: 'objective',
          entityId: 'o1',
          operation: 'insert'
        });

        const all = await client.all<{ seq: number; entity_type: string; operation: string }>(
          `SELECT seq, entity_type, operation FROM entity_changes
            WHERE workspace_id = ? ORDER BY seq ASC`,
          [WORKSPACE_ID]
        );
        assert.equal(all.length, 3);
        assert.equal(typeof all[0]!.seq, 'number');
        // Monotonic increasing seq is what the realtime poller relies on.
        assert.ok(all[0]!.seq < all[1]!.seq && all[1]!.seq < all[2]!.seq);

        // "changes since" cursor read.
        const since = all[0]!.seq;
        const delta = await client.all<{ seq: number }>(
          `SELECT seq FROM entity_changes WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC`,
          [WORKSPACE_ID, since]
        );
        assert.equal(delta.length, 2);
      } finally {
        await teardown();
      }
    });

    it('enforces idempotency-key uniqueness per workspace (protocol idempotency)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        await insertQueuedRequest(client, graph, { idempotencyKey: 'dup-key' });
        await assert.rejects(
          async () => await insertQueuedRequest(client, graph, { idempotencyKey: 'dup-key' }),
          /duplicate|unique|constraint/i
        );
        // A null key never collides.
        await insertQueuedRequest(client, graph, { idempotencyKey: null });
        await insertQueuedRequest(client, graph, { idempotencyKey: null });
      } finally {
        await teardown();
      }
    });

    it('claims a queued request exactly once under concurrency (queue claiming)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        await insertQueuedRequest(client, graph);

        const [a, b] = await Promise.all([
          await claimNextQueuedRequest(client, {
            workspaceId: WORKSPACE_ID,
            executionTargetId: graph.executionTargetId
          }),
          await claimNextQueuedRequest(client, {
            workspaceId: WORKSPACE_ID,
            executionTargetId: graph.executionTargetId
          })
        ]);

        const winners = [a, b].filter(Boolean);
        assert.equal(winners.length, 1, 'exactly one claimer wins the single queued request');

        const row = await client.get<{ status: string; attempt_count: number; revision: number }>(
          `SELECT status, attempt_count, revision FROM execution_requests WHERE id = ?`,
          [winners[0]!.id]
        );
        assert.equal(row!.status, 'claimed');
        assert.equal(row!.attempt_count, 1);
        assert.equal(row!.revision, 2);

        // Nothing left to claim.
        const third = await claimNextQueuedRequest(client, {
          workspaceId: WORKSPACE_ID,
          executionTargetId: graph.executionTargetId
        });
        assert.equal(third, null);
      } finally {
        await teardown();
      }
    });

    it('recovers stale claimed and launched requests (stale-launch recovery)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        const staleClaimed = await insertQueuedRequest(client, graph);
        const staleLaunched = await insertQueuedRequest(client, graph);
        const past = ISO(-60 * 60 * 1000); // one hour ago

        // A claim that expired before the runner started launching.
        await client.run(
          `UPDATE execution_requests
              SET status = 'claimed', claim_expires_at = ?, updated_at = ? WHERE id = ?`,
          [past, past, staleClaimed]
        );
        // A launch whose agent never attached within the TTL.
        await client.run(
          `UPDATE execution_requests
              SET status = 'launched', launched_session_id = NULL,
                  launch_completed_at = ?, updated_at = ? WHERE id = ?`,
          [past, past, staleLaunched]
        );

        const recovered = await recoverStaleExecutionRequests(client, {
          workspaceId: WORKSPACE_ID
        });
        const recoveredIds = recovered.map(r => r.id).sort();
        assert.deepEqual(recoveredIds, [staleClaimed, staleLaunched].sort());

        for (const id of [staleClaimed, staleLaunched]) {
          const row = await client.get<{ status: string }>(
            `SELECT status FROM execution_requests WHERE id = ?`,
            [id]
          );
          assert.equal(row!.status, 'expired');
        }
      } finally {
        await teardown();
      }
    });

    it('claims a queued request stamped for a client device fingerprint (remote runner)', async () => {
      if (adapter.label !== 'postgres') return;
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        const now = ISO();
        const workspaceUserId = `wu_${randomUUID()}`;
        const profileId = `profile_${randomUUID()}`;
        const clientFingerprint = `fp_client_${randomUUID().slice(0, 8)}`;

        await client.run(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES (?, ?, ?, true, ?, ?)`,
          [profileId, 'Conformance User', `${profileId}@example.test`, now, now]
        );
        await client.run(
          `INSERT INTO workspace_users
             (id, workspace_id, profile_id, member_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [workspaceUserId, WORKSPACE_ID, profileId, `auth:${profileId}`, now, now]
        );
        await client.run(
          `UPDATE devices SET fingerprint = ? WHERE id = (
             SELECT device_id FROM execution_targets WHERE id = ?
           )`,
          [clientFingerprint, graph.executionTargetId]
        );
        await client.run(
          `INSERT INTO workspace_user_execution_targets
             (id, workspace_id, workspace_user_id, execution_target_id, access_status,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, workspaceUserId, graph.executionTargetId, now, now]
        );
        await client.run(
          `INSERT INTO project_resources
             (id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'local_directory', 'Primary', '/tmp/conformance-primary', true,
                   'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, graph.projectId, graph.executionTargetId, now, now]
        );
        await client.run(
          `UPDATE objectives SET state = 'launching' WHERE id = ?`,
          [graph.objectiveId]
        );
        await insertQueuedRequest(client, graph);
        await client.run(
          `UPDATE execution_requests
              SET execution_target_id = ?
            WHERE objective_id = ?`,
          [graph.executionTargetId, graph.objectiveId]
        );

        const ctx = await createServiceContext({ db: client, source: 'runner' });
        ctx.actorWorkspaceUserId = workspaceUserId;

        const claimed = await claimNextExecutionRequest({
          ctx,
          clientDevice: {
            deviceFingerprint: clientFingerprint,
            deviceLabel: 'conformance-client',
            devicePlatform: 'darwin'
          }
        });

        assert.ok(claimed, 'runner should claim request stamped for its device fingerprint');
        assert.equal(claimed.executionTargetId, graph.executionTargetId);
        assert.equal(claimed.status, 'claimed');
      } finally {
        await teardown();
      }
    });

    it('resolves primary project resources and execution-target selection (launch path)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        const now = ISO();
        const workspaceUserId = `wu_${randomUUID()}`;
        const profileId = `profile_${randomUUID()}`;

        await client.run(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES (?, ?, ?, true, ?, ?)`,
          [profileId, 'Conformance User', `${profileId}@example.test`, now, now]
        );
        await client.run(
          `INSERT INTO workspace_users
             (id, workspace_id, profile_id, member_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [workspaceUserId, WORKSPACE_ID, profileId, `auth:${profileId}`, now, now]
        );
        await client.run(
          `INSERT INTO workspace_user_execution_targets
             (id, workspace_id, workspace_user_id, execution_target_id, access_status,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, workspaceUserId, graph.executionTargetId, now, now]
        );
        await client.run(
          `INSERT INTO project_resources
             (id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'local_directory', 'Primary', '/tmp/conformance-primary', true,
                   'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, graph.projectId, graph.executionTargetId, now, now]
        );

        const ctx = await createServiceContext({ db: client, source: 'webapp' });
        ctx.actorWorkspaceUserId = workspaceUserId;

        const primary = await findPrimaryProjectResource({
          ctx,
          projectId: graph.projectId,
          executionTargetId: graph.executionTargetId
        });
        assert.ok(primary);
        assert.equal(primary.executionTargetId, graph.executionTargetId);

        const selection = await getProjectExecutionTargetSelection({
          ctx,
          projectId: graph.projectId
        });
        assert.equal(selection.eligibleTargets.length, 1);
        assert.equal(selection.eligibleTargets[0]!.executionTargetId, graph.executionTargetId);
      } finally {
        await teardown();
      }
    });

    it('rejects provisioning the backend host as an execution target on Postgres', async () => {
      if (adapter.label !== 'postgres') return;
      const { client, teardown } = await adapter.create();
      try {
        const ctx = await createServiceContext({ db: client, source: 'webapp' });
        await assert.rejects(
          () => ensureCallerDeviceTarget({ ctx }),
          (error: unknown) =>
            error instanceof ServiceError && error.code === 'backend_not_execution_target'
        );
      } finally {
        await teardown();
      }
    });

    it('excludes the backend host target from eligible project targets', async () => {
      if (adapter.label !== 'postgres') return;
      const { client, teardown } = await adapter.create();
      try {
        const graph = await seedGraph(client);
        const now = ISO();
        const workspaceUserId = `wu_${randomUUID()}`;
        const profileId = `profile_${randomUUID()}`;

        await client.run(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES (?, ?, ?, true, ?, ?)`,
          [profileId, 'Conformance User', `${profileId}@example.test`, now, now]
        );
        await client.run(
          `INSERT INTO workspace_users
             (id, workspace_id, profile_id, member_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [workspaceUserId, WORKSPACE_ID, profileId, `auth:${profileId}`, now, now]
        );
        await client.run(
          `UPDATE devices SET fingerprint = ? WHERE id = (
             SELECT device_id FROM execution_targets WHERE id = ?
           )`,
          [backendHostFingerprint(), graph.executionTargetId]
        );
        await client.run(
          `INSERT INTO workspace_user_execution_targets
             (id, workspace_id, workspace_user_id, execution_target_id, access_status,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, workspaceUserId, graph.executionTargetId, now, now]
        );
        await client.run(
          `INSERT INTO project_resources
             (id, workspace_id, project_id, execution_target_id, type, label, path,
              is_primary, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'local_directory', 'Primary', '/tmp/conformance-primary', true,
                   'active', ?, ?)`,
          [randomUUID(), WORKSPACE_ID, graph.projectId, graph.executionTargetId, now, now]
        );

        const ctx = await createServiceContext({ db: client, source: 'webapp' });
        ctx.actorWorkspaceUserId = workspaceUserId;

        const eligible = await listEligibleProjectExecutionTargets({
          ctx,
          projectId: graph.projectId
        });
        assert.equal(eligible.length, 0);
      } finally {
        await teardown();
      }
    });

    it('rolls back a failed transaction and commits a successful one (service-layer transactions)', async () => {
      const { client, teardown } = await adapter.create();
      try {
        // Rollback: a throw mid-transaction leaves no rows behind.
        await assert.rejects(
          client.transaction(async tx => {
            await appendChange(tx, {
              entityType: 'mission',
              entityId: 'rollback',
              operation: 'insert'
            });
            throw new Error('boom');
          }),
          /boom/
        );
        const afterRollback = await client.all(
          `SELECT id FROM entity_changes WHERE entity_id = 'rollback'`
        );
        assert.equal(afterRollback.length, 0);

        // Commit: a clean transaction persists its writes.
        await client.transaction(async tx => {
          await appendChange(tx, {
            entityType: 'mission',
            entityId: 'commit',
            operation: 'insert'
          });
        });
        const afterCommit = await client.all(
          `SELECT id FROM entity_changes WHERE entity_id = 'commit'`
        );
        assert.equal(afterCommit.length, 1);
      } finally {
        await teardown();
      }
    });
  });
}

after(() => {
  if (!process.env.TEST_DATABASE_URL) {
    // Surfaced once so a green local run does not imply Postgres was exercised.
    console.error(
      '[postgres-conformance] TEST_DATABASE_URL not set — Postgres battery skipped; SQLite battery ran.'
    );
  }
});
