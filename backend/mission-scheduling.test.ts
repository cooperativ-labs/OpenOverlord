import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'overlord-webapp-mission-scheduling-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
const { WORKSPACE } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});

const { db } = await import('./db.ts');
const {
  createMission,
  createProject,
  createProjectTag,
  getMissionDetail,
  getMissionSchedule,
  listMissions,
  previewMissionSchedule,
  upsertMissionSchedule,
  clearMissionSchedule,
  updateMission,
  reorderBoardColumn
} = await import('./repository.ts');
const { ApiError } = await import('./errors.ts');

function statusId(key: string): string {
  const row = db
    .prepare(`SELECT id FROM workspace_statuses WHERE workspace_id = ? AND key = ?`)
    .get(WORKSPACE.id, key) as { id: string } | undefined;
  if (!row) throw new Error(`Seed status missing: ${key}`);
  return row.id;
}

const DAILY_UTC_SCHEDULE = {
  periodType: 'd' as const,
  periodInterval: 1,
  timezone: 'UTC',
  daysOfWeek: [{ dayNum: 1, times: ['09:00:00'] }]
};

describe('previewMissionSchedule', () => {
  it('computes the next due datetime without persisting anything', () => {
    const result = previewMissionSchedule({
      schedule: DAILY_UTC_SCHEDULE,
      itemDueDatetime: '2026-03-24T09:00:00.000Z'
    });
    assert.equal(result.dueDatetime, '2026-03-25T09:00:00.000Z');
  });

  it('rejects an invalid schedule with a 400 ApiError', () => {
    assert.throws(
      () =>
        previewMissionSchedule({
          schedule: { ...DAILY_UTC_SCHEDULE, timezone: 'Mars/Base' }
        }),
      (err: unknown) => err instanceof ApiError && err.status === 400
    );
  });
});

describe('mission schedule upsert/get/clear', () => {
  it('creates a schedule, computes due_datetime, and surfaces both on the mission', async () => {
    const project = await createProject({ name: 'Scheduling Project A' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Weekly review' });

    const result = await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);
    assert.ok(result.schedule);
    assert.equal(result.schedule?.periodType, 'd');
    assert.ok(result.dueDatetime);

    const detail = await getMissionDetail(mission.id);
    assert.equal(detail.scheduleId, result.schedule?.id);
    assert.equal(detail.dueDatetime, result.dueDatetime);

    const fetched = await getMissionSchedule(mission.id);
    assert.equal(fetched.schedule?.id, result.schedule?.id);
    assert.equal(fetched.dueDatetime, result.dueDatetime);
  });

  it('updates the same schedule row in place on a second upsert (no duplicate row)', async () => {
    const project = await createProject({ name: 'Scheduling Project B' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Standup' });

    const first = await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);
    const second = await upsertMissionSchedule(mission.id, {
      ...DAILY_UTC_SCHEDULE,
      periodInterval: 2
    });

    assert.equal(second.schedule?.id, first.schedule?.id);
    assert.equal(second.schedule?.periodInterval, 2);

    const rowCount = db
      .prepare(`SELECT COUNT(*) AS n FROM schedules WHERE id = ?`)
      .get(first.schedule?.id) as { n: number };
    assert.equal(rowCount.n, 1);
  });

  it('clears the mission link and deletes the schedule row when unreferenced', async () => {
    const project = await createProject({ name: 'Scheduling Project C' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'One-off' });
    const { schedule } = await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);

    await clearMissionSchedule(mission.id);

    const detail = await getMissionDetail(mission.id);
    assert.equal(detail.scheduleId, null);
    assert.equal(detail.dueDatetime, null);

    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM schedules WHERE id = ?`)
      .get(schedule?.id) as { n: number };
    assert.equal(remaining.n, 0);
  });

  it('keeps the schedule row when another mission still references it', async () => {
    const project = await createProject({ name: 'Scheduling Project D' });
    const missionA = await createMission({ projectId: project.id, firstObjective: 'A' });
    const missionB = await createMission({ projectId: project.id, firstObjective: 'B' });

    const { schedule } = await upsertMissionSchedule(missionA.id, DAILY_UTC_SCHEDULE);
    // Point missionB's schedule_id at the same schedule row directly (simulating
    // two missions sharing one recurrence rule) without going through upsert,
    // which always mints its own schedule.
    db.prepare(`UPDATE missions SET schedule_id = ? WHERE id = ?`).run(schedule?.id, missionB.id);

    await clearMissionSchedule(missionA.id);

    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM schedules WHERE id = ?`)
      .get(schedule?.id) as { n: number };
    assert.equal(remaining.n, 1);
  });
});

describe('scheduled mission completion trigger', () => {
  it('spawns a duplicate mission with the next due date when a scheduled mission completes', async () => {
    const project = await createProject({ name: 'Scheduling Trigger A' });
    const tag = await createProjectTag(project.id, { label: 'recurring' });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Write the weekly report',
      priority: 'high',
      tagIds: [tag.id]
    });
    const { dueDatetime, schedule } = await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);

    const beforeMissions = await listMissions(project.id);
    assert.equal(beforeMissions.length, 1);

    await updateMission(mission.id, { statusId: statusId('done') });

    const afterMissions = await listMissions(project.id);
    assert.equal(afterMissions.length, 2);

    const duplicate = afterMissions.find(m => m.id !== mission.id);
    assert.ok(duplicate);
    assert.equal(duplicate?.title, mission.title);
    assert.equal(duplicate?.priority, 'high');
    assert.equal(duplicate?.scheduleId, schedule?.id);
    assert.equal(duplicate?.tags.length, 1);
    assert.equal(duplicate?.tags[0]?.id, tag.id);
    assert.notEqual(duplicate?.dueDatetime, dueDatetime);
    assert.ok(duplicate?.dueDatetime && duplicate.dueDatetime > (dueDatetime ?? ''));

    const duplicateDetail = await getMissionDetail(duplicate!.id);
    assert.equal(duplicateDetail.objectives[0]?.instructionText, 'Write the weekly report');
  });

  it('does not spawn a duplicate when the mission moves to cancelled', async () => {
    const project = await createProject({ name: 'Scheduling Trigger B' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Daily standup' });
    await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);

    await updateMission(mission.id, { statusId: statusId('cancelled') });

    const missions = await listMissions(project.id);
    assert.equal(missions.length, 1);
  });

  it('does not spawn a second duplicate when the same complete status is re-saved', async () => {
    const project = await createProject({ name: 'Scheduling Trigger C' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Monthly audit' });
    await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);

    await updateMission(mission.id, { statusId: statusId('done') });
    assert.equal((await listMissions(project.id)).length, 2);

    // Re-saving the same status (e.g. an idempotent PATCH) must not spawn another.
    await updateMission(mission.id, { statusId: statusId('done') });
    assert.equal((await listMissions(project.id)).length, 2);
  });

  it('does not spawn a duplicate for an unscheduled mission reaching complete', async () => {
    const project = await createProject({ name: 'Scheduling Trigger D' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'No schedule' });

    await updateMission(mission.id, { statusId: statusId('done') });

    const missions = await listMissions(project.id);
    assert.equal(missions.length, 1);
  });

  it('spawns a duplicate via the board reorder path (drag onto a complete column)', async () => {
    const project = await createProject({ name: 'Scheduling Trigger E' });
    const mission = await createMission({ projectId: project.id, firstObjective: 'Drag me' });
    await upsertMissionSchedule(mission.id, DAILY_UTC_SCHEDULE);

    await reorderBoardColumn(project.id, {
      statusId: statusId('done'),
      orderedMissionIds: [mission.id]
    });

    const missions = await listMissions(project.id);
    assert.equal(missions.length, 2);
  });
});
