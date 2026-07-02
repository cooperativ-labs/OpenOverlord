import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';

describe('mission project move', () => {
  it('updates mission project_id via updateMission', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-project-move-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
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
  });
});
