import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-launch-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db } = await import('./db.ts');
const { createProject, createProjectResource, createMission } = await import('./repository.ts');
const { launchObjective } = await import('./launch.ts');

test('launching an objective twice while a request is active returns the same request', () => {
  const project = createProject({ name: 'Idempotent Launch Test' });
  createProjectResource(project.id, {
    directoryPath: mkdtempSync(path.join(tmpdir(), 'overlord-launch-resource-')),
    executionTargetId: null,
    isPrimary: true
  });
  const mission = createMission({
    projectId: project.id,
    firstObjective: 'Do the thing'
  });
  const objectiveId = mission.objectives[0]!.id;

  const first = launchObjective(objectiveId, { agent: 'codex' });
  const second = launchObjective(objectiveId, { agent: 'codex' });

  assert.equal(second.id, first.id);
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM execution_requests WHERE objective_id = ?`)
    .get(objectiveId) as { n: number };
  assert.equal(count.n, 1);

  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
