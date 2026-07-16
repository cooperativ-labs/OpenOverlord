import { createMissionWithObjectives } from '@overlord/core/service/missions';
import { addProjectResource, createProject } from '@overlord/core/service/projects';
import {
  attachSession,
  deliverSession,
  recordHookEvent,
  updateSession
} from '@overlord/core/service/protocol';
import {
  listSqliteMigrationFiles,
  migrateDatabase,
  openInMemoryDatabase
} from '@overlord/database';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeededCliContext } from './support/seeded-context.ts';

test('protocol lifecycle: attach → update → deliver', async () => {
  const { db, ctx } = await createSeededCliContext({ source: 'protocol' });

  const project = await createProject({ ctx, name: 'Test Project' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });

  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Implement feature X' }]
  });
  assert.equal(mission.statusType, 'draft');

  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const attached = await attachSession({
    ctx,
    missionId: mission.id,
    agentIdentifier: 'test-agent'
  });
  assert.ok(attached.sessionKey);
  assert.equal(attached.mission.statusType, 'execute');
  assert.equal(attached.objective.state, 'executing');
  assert.equal(attached.objective.objective, 'Implement feature X');
  assert.match(attached.agentInstructions, /objective\.objective/);
  assert.match(attached.agentInstructions, /Implement feature X/);
  assert.match(attached.agentInstructions, /immediately begin executing it/i);
  assert.match(attached.agentInstructions, /do not wait for more instructions/i);

  const sessionRow = (await ctx.db.get(
    `SELECT external_session_id FROM agent_sessions WHERE id = ?`,
    [attached.session.id]
  )) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, null);

  await updateSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Made progress on feature X'
  });

  const delivered = await deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Completed feature X implementation'
  });
  assert.ok(delivered.deliveryId);

  const missionRow = (await ctx.db.get(`SELECT status_type FROM missions WHERE id = ?`, [
    mission.id
  ])) as { status_type: string };
  assert.equal(missionRow.status_type, 'review');

  const objectiveRow = (await ctx.db.get(`SELECT state FROM objectives WHERE id = ?`, [
    objectives[0]?.id
  ])) as { state: string };
  assert.equal(objectiveRow.state, 'complete');

  await db.close();
});

test('attach records and clears native external session id', async () => {
  const { db, ctx } = await createSeededCliContext({ source: 'protocol' });

  const project = await createProject({ ctx, name: 'External Session Test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Track native session id' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const attached = await attachSession({
    ctx,
    missionId: mission.id,
    agentIdentifier: 'claude',
    externalSessionId: 'claude-native-123'
  });

  let sessionRow = (await ctx.db.get(
    `SELECT external_session_id FROM agent_sessions WHERE id = ?`,
    [attached.session.id]
  )) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, 'claude-native-123');

  await attachSession({
    ctx,
    missionId: mission.id,
    existingSessionKey: attached.sessionKey,
    externalSessionId: null
  });

  sessionRow = (await ctx.db.get(`SELECT external_session_id FROM agent_sessions WHERE id = ?`, [
    attached.session.id
  ])) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, null);

  await db.close();
});

test('hook-event persists external session id on the active agent session', async () => {
  const { db, ctx } = await createSeededCliContext({ source: 'protocol' });

  const project = await createProject({ ctx, name: 'Hook external session test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Capture hook session id' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const attached = await attachSession({
    ctx,
    missionId: mission.id,
    agentIdentifier: 'cursor'
  });

  await recordHookEvent({
    ctx,
    missionId: mission.displayId,
    hookType: 'UserPromptSubmit',
    prompt: 'Follow-up from the harness',
    sessionKey: attached.sessionKey,
    externalSessionId: 'cursor-conversation-abc',
    turnIndex: '1'
  });

  const sessionRow = (await ctx.db.get(
    `SELECT external_session_id FROM agent_sessions WHERE id = ?`,
    [attached.session.id]
  )) as { external_session_id: string | null };
  assert.equal(sessionRow.external_session_id, 'cursor-conversation-abc');

  await db.close();
});

test('attach response includes attach-response-v3 fields', async () => {
  const { db, ctx } = await createSeededCliContext({ source: 'protocol' });

  const project = await createProject({ ctx, name: 'Shape Test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Verify attach shape' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const attached = await attachSession({ ctx, missionId: mission.id });
  assert.equal(attached.mission.statusType, 'execute');
  for (const field of [
    'history',
    'artifacts',
    'attachments',
    'previousObjectives',
    'futureObjectives',
    'session',
    'sharedState',
    'agentInstructions'
  ] as const) {
    assert.ok(field in attached, `missing ${field}`);
  }
  assert.ok(!('objectives' in attached), 'objectives field should be removed in v2+');
  assert.ok(!('promptContext' in attached), 'promptContext field should be removed in v3');
  assert.ok(attached.session.sessionKey);
  assert.ok(attached.agentInstructions.includes('Required Protocol Workflow'));

  await db.close();
});

test('migrateDatabase applies every discovered SQLite migration without resetting data', () => {
  const db = openInMemoryDatabase();
  const now = '2026-01-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO organizations (id, name, settings_json, created_at, updated_at, revision)
     VALUES (?, ?, '{}', ?, ?, 1)`
  ).run('org-migration-smoke', 'Migration smoke org', now, now);

  db.prepare(
    `INSERT INTO workspaces (
      id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision
    ) VALUES (
      'workspace-migration-smoke', ?, 'migration-smoke', 'Migration smoke test', 'local', '{}',
      ?, ?, 1
    )`
  ).run('org-migration-smoke', now, now);

  migrateDatabase(db);

  const applied = db
    .prepare(
      `SELECT version
       FROM schema_migrations
       WHERE adapter = 'sqlite'
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
