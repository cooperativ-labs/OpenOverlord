import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('mission reference resolution', () => {
  it('resolves missions by UUID or display_id for detail and child reads', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-mission-ref-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createMission, getMissionDetail, listMissionEvents } =
      await import('./repository.ts');

    const project = createProject({ name: 'Mission Ref Test' });
    const created = createMission({
      projectId: project.id,
      firstObjective: 'Resolve by display id'
    });

    assert.equal(getMissionDetail(created.id).id, created.id);
    assert.equal(getMissionDetail(created.displayId).id, created.id);
    assert.equal(getMissionDetail(created.displayId).displayId, created.displayId);
    assert.doesNotThrow(() => listMissionEvents(created.displayId));
  });

  it('assigns new missions to the creator by default, unless explicitly unassigned', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-mission-assignee-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createMission } = await import('./repository.ts');
    const { ACTOR_WORKSPACE_USER_ID } = await import('./db.ts');

    const project = createProject({ name: 'Mission Assignee Test' });
    const created = createMission({
      projectId: project.id,
      firstObjective: 'Default assignee to creator'
    });
    assert.equal(created.assignedWorkspaceUserId, ACTOR_WORKSPACE_USER_ID);

    const explicitlyUnassigned = createMission({
      projectId: project.id,
      firstObjective: 'Allow explicit unassign on create',
      assignedWorkspaceUserId: null
    });
    assert.equal(explicitlyUnassigned.assignedWorkspaceUserId, null);
  });
});
