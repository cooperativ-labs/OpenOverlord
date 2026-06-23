import { listSqliteMigrationFiles, migrateDatabase } from '@overlord/database';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createServiceContext } from '../../src/service/context.ts';
import { createMissionWithObjectives } from '../../src/service/missions.ts';
import { addProjectResource, createProject } from '../../src/service/projects.ts';
import {
  attachSession,
  deliverSession,
  recordHookEvent,
  updateSession
} from '../../src/service/protocol.ts';

test('protocol lifecycle: attach → update → deliver', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const ctx = createServiceContext({ db, source: 'protocol' });

  const project = createProject({ ctx, name: 'Test Project' });
  addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });

  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Implement feature X' }]
  });
  assert.equal(mission.statusType, 'draft');

  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const attached = attachSession({ ctx, missionId: mission.id, agentIdentifier: 'test-agent' });
  assert.ok(attached.sessionKey);
  assert.equal(attached.mission.statusType, 'execute');
  assert.equal(attached.objective.state, 'executing');
  assert.match(attached.promptContext, /Implement feature X/);

  const sessionRow = ctx.db
    .prepare(`SELECT external_session_id FROM agent_sessions WHERE id = ?`)
    .get(attached.session.id) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, null);

  updateSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Made progress on feature X'
  });

  const delivered = deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Completed feature X implementation'
  });
  assert.ok(delivered.deliveryId);

  const missionRow = ctx.db
    .prepare(`SELECT status_type FROM missions WHERE id = ?`)
    .get(mission.id) as { status_type: string };
  assert.equal(missionRow.status_type, 'review');

  const objectiveRow = ctx.db
    .prepare(`SELECT state FROM objectives WHERE id = ?`)
    .get(objectives[0]?.id) as { state: string };
  assert.equal(objectiveRow.state, 'complete');

  db.close();
});

test('attach records and clears native external session id', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const ctx = createServiceContext({ db, source: 'protocol' });

  const project = createProject({ ctx, name: 'External Session Test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Track native session id' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const attached = attachSession({
    ctx,
    missionId: mission.id,
    agentIdentifier: 'claude',
    externalSessionId: 'claude-native-123'
  });

  let sessionRow = ctx.db
    .prepare(`SELECT external_session_id FROM agent_sessions WHERE id = ?`)
    .get(attached.session.id) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, 'claude-native-123');

  attachSession({
    ctx,
    missionId: mission.id,
    existingSessionKey: attached.sessionKey,
    externalSessionId: null
  });

  sessionRow = ctx.db
    .prepare(`SELECT external_session_id FROM agent_sessions WHERE id = ?`)
    .get(attached.session.id) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, null);

  db.close();
});

test('hook-event persists external session id on the active agent session', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const ctx = createServiceContext({ db, source: 'protocol' });

  const project = createProject({ ctx, name: 'Hook external session test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Capture hook session id' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const attached = attachSession({ ctx, missionId: mission.id, agentIdentifier: 'cursor' });

  recordHookEvent({
    ctx,
    missionId: mission.displayId,
    hookType: 'UserPromptSubmit',
    prompt: 'Follow-up from the harness',
    sessionKey: attached.sessionKey,
    externalSessionId: 'cursor-conversation-abc',
    turnIndex: '1'
  });

  const sessionRow = ctx.db
    .prepare(`SELECT external_session_id FROM agent_sessions WHERE id = ?`)
    .get(attached.session.id) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, 'cursor-conversation-abc');

  db.close();
});

test('attach response includes attach-response-v1 fields', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  const ctx = createServiceContext({ db, source: 'protocol' });

  const project = createProject({ ctx, name: 'Shape Test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Verify attach shape' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const attached = attachSession({ ctx, missionId: mission.id });
  assert.equal(attached.mission.statusType, 'execute');
  for (const field of [
    'history',
    'artifacts',
    'attachments',
    'objectives',
    'session',
    'sharedState',
    'promptContext'
  ] as const) {
    assert.ok(field in attached, `missing ${field}`);
  }
  assert.ok(attached.session.sessionKey);
  assert.ok(attached.promptContext.includes('Required protocol workflow'));

  db.close();
});

test('migrateDatabase applies every discovered SQLite migration without resetting data', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);

  db.prepare(
    `INSERT INTO workspaces (
      id, slug, name, kind, settings_json, created_at, updated_at, revision
    ) VALUES (
      'workspace-migration-smoke', 'migration-smoke', 'Migration smoke test', 'local', '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
    )`
  ).run();
  migrateDatabase(db);

  const applied = db
    .prepare(
      `SELECT version
       FROM schema_migrations
       WHERE adapter = 'sqlite' AND component = 'core'
       ORDER BY version`
    )
    .all() as Array<{ version: string }>;
  const workspace = db
    .prepare(`SELECT name FROM workspaces WHERE id = 'workspace-migration-smoke'`)
    .get() as { name: string } | undefined;

  assert.deepEqual(
    applied.map(row => row.version),
    listSqliteMigrationFiles().map(fileName => fileName.split('_', 1)[0])
  );
  assert.equal(workspace?.name, 'Migration smoke test');
  db.close();
});
