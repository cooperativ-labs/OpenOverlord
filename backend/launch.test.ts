import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-launch-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
const { db } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});
const { createProject, createProjectResource, createMission, createObjective, updateObjective } =
  await import('./repository.ts');
const { launchObjective, getAgentCatalog, updateAgentCatalog } = await import('./launch.ts');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('launching an objective twice while a request is active returns the same request', async () => {
  const project = await createProject({ name: 'Idempotent Launch Test' });
  await createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join(tmpdir(), 'overlord-launch-resource-')),
    executionTargetId: null,
    isPrimary: true
  });
  const mission = await createMission({
    projectId: project.id,
    firstObjective: 'Do the thing'
  });
  const objectiveId = mission.objectives[0]!.id;

  const first = await launchObjective(objectiveId, { agent: 'codex' });
  const second = await launchObjective(objectiveId, { agent: 'codex' });

  assert.equal(second.id, first.id);
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM execution_requests WHERE objective_id = ?`)
    .get(objectiveId) as { n: number };
  assert.equal(count.n, 1);

  await updateObjective(objectiveId, { state: 'complete' });

  const cleared = db
    .prepare(`SELECT status FROM execution_requests WHERE id = ?`)
    .get(first.id) as { status: string };
  assert.equal(cleared.status, 'cleared');

  const manualEvent = db
    .prepare(
      `SELECT summary, payload_json FROM mission_events
        WHERE objective_id = ? AND type = 'status_change'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(objectiveId) as { summary: string; payload_json: string };
  assert.equal(
    manualEvent.summary,
    'Objective completed: cleared 1 queued execution request(s) and ended 0 active session(s).'
  );
  assert.equal(JSON.parse(manualEvent.payload_json).clearedRequests, 1);

  const serviceClearEvents = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mission_events
        WHERE objective_id = ? AND summary = 'Cleared execution request.'`
    )
    .get(objectiveId) as { n: number };
  assert.equal(serviceClearEvents.n, 0);
});

test('parking an active objective to submitted clears its queue and allows launching a sibling', async () => {
  const project = await createProject({ name: 'Disconnect Park Launch Test' });
  await createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join(tmpdir(), 'overlord-launch-park-resource-')),
    executionTargetId: null,
    isPrimary: true
  });
  const mission = await createMission({
    projectId: project.id,
    firstObjective: 'First objective'
  });
  const firstObjectiveId = mission.objectives[0]!.id;
  const firstRequest = await launchObjective(firstObjectiveId, { agent: 'codex' });

  const second = await createObjective({
    missionId: mission.id,
    instructionText: 'Second objective'
  });

  await assert.rejects(() => launchObjective(second.id, { agent: 'codex' }), /Enable auto-advance/);

  const parked = await updateObjective(firstObjectiveId, { state: 'submitted' });
  assert.equal(parked.state, 'submitted');

  const cleared = db
    .prepare(`SELECT status FROM execution_requests WHERE id = ?`)
    .get(firstRequest.id) as { status: string };
  assert.equal(cleared.status, 'cleared');

  const secondRequest = await launchObjective(second.id, { agent: 'codex' });
  assert.equal(secondRequest.objectiveId, second.id);
});

test('launching ignores stale active requests tied to completed objectives', async () => {
  const project = await createProject({ name: 'Stale Completed Request Launch Test' });
  await createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join(tmpdir(), 'overlord-launch-stale-resource-')),
    executionTargetId: null,
    isPrimary: true
  });
  const mission = await createMission({
    projectId: project.id,
    firstObjective: 'Completed objective'
  });
  const completedObjectiveId = mission.objectives[0]!.id;
  await updateObjective(completedObjectiveId, { state: 'complete' });

  const now = new Date().toISOString();
  const staleRequestId = crypto.randomUUID();
  const missionRow = db
    .prepare(`SELECT workspace_id, project_id FROM missions WHERE id = ?`)
    .get(mission.id) as { workspace_id: string; project_id: string };
  db.prepare(
    `INSERT INTO execution_requests
       (id, workspace_id, project_id, mission_id, objective_id, requested_agent, launch_mode,
        launch_flags_json, target_kind, requested_source, status, metadata_json, created_at,
        updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 'codex', 'run', '{}', 'any', 'webapp', 'queued', '{}', ?, ?, 1)`
  ).run(
    staleRequestId,
    missionRow.workspace_id,
    missionRow.project_id,
    mission.id,
    completedObjectiveId,
    now,
    now
  );

  const second = await createObjective({
    missionId: mission.id,
    instructionText: 'Next objective'
  });

  const request = await launchObjective(second.id, { agent: 'codex' });
  assert.equal(request.objectiveId, second.id);
});

test('launching another objective while one is active is rejected without queueing', async () => {
  const project = await createProject({ name: 'Busy Mission Launch Test' });
  await createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join(tmpdir(), 'overlord-launch-busy-resource-')),
    executionTargetId: null,
    isPrimary: true
  });
  const mission = await createMission({
    projectId: project.id,
    firstObjective: 'First objective'
  });
  const firstObjectiveId = mission.objectives[0]!.id;
  await launchObjective(firstObjectiveId, { agent: 'codex' });

  const second = await createObjective({
    missionId: mission.id,
    instructionText: 'Second objective'
  });

  await assert.rejects(() => launchObjective(second.id, { agent: 'codex' }), /Enable auto-advance/);

  const secondRequestCount = db
    .prepare(`SELECT COUNT(*) AS n FROM execution_requests WHERE objective_id = ?`)
    .get(second.id) as { n: number };
  assert.equal(secondRequestCount.n, 0);

  const secondObjective = db
    .prepare(`SELECT auto_advance FROM objectives WHERE id = ?`)
    .get(second.id) as { auto_advance: number };
  assert.equal(secondObjective.auto_advance, 0);
});

test('updateAgentCatalog persists model order and display names', async () => {
  const initial = await getAgentCatalog();
  const cursor = initial.agents.find(agent => agent.key === 'cursor');
  assert.ok(cursor);
  assert.ok(cursor.models.length >= 2);

  const reversed = [...cursor.models].reverse();
  const updated = await updateAgentCatalog({
    agents: initial.agents.map(agent =>
      agent.key === 'cursor'
        ? {
            ...agent,
            models: reversed.map((model, index) => ({
              ...model,
              displayName: index === 0 ? 'Top Model' : model.displayName
            }))
          }
        : agent
    )
  });

  const savedCursor = updated.agents.find(agent => agent.key === 'cursor');
  assert.ok(savedCursor);
  assert.equal(savedCursor.models[0]?.displayName, 'Top Model');
  assert.equal(
    savedCursor.models.map(model => model.id).join(','),
    reversed.map(model => model.id).join(',')
  );

  const row = db
    .prepare(`SELECT settings_json FROM workspaces WHERE deleted_at IS NULL LIMIT 1`)
    .get() as { settings_json: string };
  const settings = JSON.parse(row.settings_json) as {
    agentCatalog?: { agents?: { cursor?: { models?: Array<{ displayName: string }> } } };
  };
  assert.equal(settings.agentCatalog?.agents?.cursor?.models?.[0]?.displayName, 'Top Model');
});
