import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-launch-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db, initDatabase } = await import('./db.ts');
await initDatabase();
const { createProject, createProjectResource, createMission, createObjective, updateObjective } =
  await import('./repository.ts');
const { launchObjective } = await import('./launch.ts');

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
