import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-objectives-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
await bootstrapIntegrationTestDb({ sqlitePath: path.join(tempDir, 'webapp.sqlite') });

const { db, WORKSPACE, setActiveWorkspaceUser, nowIso, newId, recordChange } =
  await import('./db.ts');
const { entityChangeDtoFromRow, parseChangedFields, readChangesAfter } =
  await import('./realtime.ts');
const { createMission, createProject, createObjective, reorderFutureObjectives, updateObjective } =
  await import('./repository.ts');
const { updateLaunchPreference } = await import('./launch.ts');
const { ApiError } = await import('./errors.ts');

// Operator is seeded by bootstrapIntegrationTestDb.

test('realtime change DTOs include safely parsed changed fields', () => {
  assert.deepEqual(parseChangedFields('["state","completed_at"]'), ['state', 'completed_at']);
  assert.deepEqual(parseChangedFields('{"state":true}'), []);
  assert.deepEqual(parseChangedFields('not json'), []);
  assert.deepEqual(parseChangedFields('["state",42,null,"phase"]'), ['state', 'phase']);

  const dto = entityChangeDtoFromRow({
    seq: 42,
    entity_type: 'objective',
    entity_id: 'objective-1',
    operation: 'update',
    project_id: 'project-1',
    mission_id: 'mission-1',
    objective_id: 'objective-1',
    changed_fields_json: '["state","completed_at"]',
    occurred_at: '2026-06-29T00:00:00.000Z'
  });

  assert.deepEqual(dto, {
    seq: 42,
    entityType: 'objective',
    entityId: 'objective-1',
    operation: 'update',
    projectId: 'project-1',
    missionId: 'mission-1',
    objectiveId: 'objective-1',
    changedFields: ['state', 'completed_at'],
    occurredAt: '2026-06-29T00:00:00.000Z'
  });
});

test('realtime catch-up reads changes after the cursor in order', async () => {
  const before = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM entity_changes`).get() as {
    seq: number;
  };

  await recordChange({
    entityType: 'test_sync',
    entityId: 'sync-1',
    operation: 'insert',
    changedFields: ['state']
  });
  await recordChange({
    entityType: 'test_sync',
    entityId: 'sync-2',
    operation: 'update',
    changedFields: ['state', 'updated_at']
  });

  const firstPage = await readChangesAfter(before.seq, 1);
  assert.equal(firstPage.changes.length, 1);
  assert.equal(firstPage.changes[0]!.entityId, 'sync-1');
  assert.equal(firstPage.hasMore, true);

  const secondPage = await readChangesAfter(firstPage.cursor, 1);
  assert.equal(secondPage.changes.length, 1);
  assert.equal(secondPage.changes[0]!.entityId, 'sync-2');
  assert.deepEqual(secondPage.changes[0]!.changedFields, ['state', 'updated_at']);
  assert.equal(secondPage.hasMore, false);

  const emptyPage = await readChangesAfter(secondPage.cursor, 1);
  assert.deepEqual(emptyPage, { changes: [], cursor: secondPage.cursor, hasMore: false });
});

test('clearing a draft objective instruction to empty leaves it blank instead of erroring', async () => {
  const project = await createProject({ name: 'Clear Instruction Test' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = mission.objectives[0]!.id;

  const updated = await updateObjective(objectiveId, { instructionText: '   ' });

  assert.equal(updated.instructionText, '');
});

test('clearing a submitted objective instruction to empty is still rejected', async () => {
  const project = await createProject({ name: 'Clear Submitted Instruction Test' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = mission.objectives[0]!.id;
  await updateObjective(objectiveId, { state: 'submitted' });

  await assert.rejects(
    updateObjective(objectiveId, { instructionText: '   ' }),
    (err: unknown) => err instanceof ApiError && err.status === 400
  );
});

test('new draft objectives inherit the project last-used agent', async () => {
  const project = await createProject({ name: 'Default Agent Objectives' });
  updateLaunchPreference(project.id, {
    selectedAgent: 'claude',
    selectedModel: 'claude-opus-4-8',
    selectedReasoningEffort: 'high'
  });

  // The mission's first objective is created through the same insert path and must
  // record the launch selection so the button and execution read it from the db.
  const mission = await createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const firstObjective = mission.objectives[0]!;
  assert.equal(firstObjective.assignedAgent, 'claude');
  assert.equal(firstObjective.model, 'claude-opus-4-8');
  assert.equal(firstObjective.reasoningEffort, 'high');

  // A blank draft slot added afterwards (the add-objective affordance) also stamps
  // the agent rather than leaving it null for auto-advance to misread.
  const added = await createObjective({ missionId: mission.id, instructionText: '' });
  assert.equal(added.assignedAgent, 'claude');
  assert.equal(added.model, 'claude-opus-4-8');
  assert.equal(added.reasoningEffort, 'high');
});

test('new draft objectives leave the agent unset without a launch preference', async () => {
  const project = await createProject({ name: 'No Preference Objectives' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  assert.equal(mission.objectives[0]!.assignedAgent, null);
});

test('reordering future objectives persists swaps without violating the unique position constraint', async () => {
  const project = await createProject({ name: 'Future Objective Reorder' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'First draft' });
  const second = await createObjective({
    missionId: mission.id,
    instructionText: 'Second future objective',
    state: 'draft'
  });
  const third = await createObjective({
    missionId: mission.id,
    instructionText: 'Third future objective',
    state: 'draft'
  });

  const reordered = await reorderFutureObjectives(mission.id, {
    orderedObjectiveIds: [third.id, second.id]
  });

  assert.deepEqual(
    reordered.map(objective => ({
      text: objective.instructionText,
      state: objective.state,
      position: objective.position
    })),
    [
      { text: 'First draft', state: 'draft', position: 0 },
      { text: 'Third future objective', state: 'future', position: 1 },
      { text: 'Second future objective', state: 'future', position: 2 }
    ]
  );
});

test('marking a queued objective executing promotes the earliest future objective to draft', async () => {
  const project = await createProject({ name: 'Promote Future On Execute' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Execute first' });
  const running = mission.objectives[0]!;
  const future = await createObjective({
    missionId: mission.id,
    instructionText: 'Continue with second objective',
    state: 'draft'
  });

  assert.equal(future.state, 'future');

  await updateObjective(running.id, { state: 'executing' });

  const rows = db
    .prepare(
      `SELECT id, instruction_text, state
       FROM objectives
       WHERE mission_id = ? AND deleted_at IS NULL
       ORDER BY position ASC`
    )
    .all(mission.id) as Array<{ id: string; instruction_text: string; state: string }>;

  assert.deepEqual(
    rows.map(row => row.state),
    ['executing', 'draft']
  );
  assert.equal(rows[1]!.id, future.id);
  assert.equal(rows[1]!.instruction_text, 'Continue with second objective');
});

test('marking a queued objective executing promotes future over a blank draft placeholder', async () => {
  const project = await createProject({ name: 'Promote Future Over Placeholder' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Execute first' });
  const running = mission.objectives[0]!;
  db.prepare(`UPDATE objectives SET state = 'launching' WHERE id = ?`).run(running.id);

  const placeholder = await createObjective({
    missionId: mission.id,
    instructionText: '',
    state: 'draft'
  });
  const future = await createObjective({
    missionId: mission.id,
    instructionText: 'Continue with real future objective',
    state: 'draft'
  });

  assert.equal(placeholder.state, 'draft');
  assert.equal(future.state, 'future');

  await updateObjective(running.id, { state: 'executing' });

  const rows = db
    .prepare(
      `SELECT id, instruction_text, state
       FROM objectives
       WHERE mission_id = ? AND deleted_at IS NULL
       ORDER BY position ASC`
    )
    .all(mission.id) as Array<{ id: string; instruction_text: string; state: string }>;

  assert.deepEqual(
    rows.map(row => row.state),
    ['executing', 'draft']
  );
  assert.equal(rows[1]!.id, future.id);
  assert.equal(rows[1]!.instruction_text, 'Continue with real future objective');

  const placeholderRow = db
    .prepare(`SELECT deleted_at FROM objectives WHERE id = ?`)
    .get(placeholder.id) as { deleted_at: string | null };
  assert.ok(placeholderRow.deleted_at);
});

test('marking the only queued objective executing creates a blank draft fallback', async () => {
  const project = await createProject({ name: 'Blank Draft On Execute' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Execute first' });
  const running = mission.objectives[0]!;

  await updateObjective(running.id, { state: 'executing', assignedAgent: 'codex' });

  const rows = db
    .prepare(
      `SELECT instruction_text, state, assigned_agent
       FROM objectives
       WHERE mission_id = ? AND deleted_at IS NULL
       ORDER BY position ASC`
    )
    .all(mission.id) as Array<{
    instruction_text: string;
    state: string;
    assigned_agent: string | null;
  }>;

  assert.deepEqual(
    rows.map(row => row.state),
    ['executing', 'draft']
  );
  assert.equal(rows[1]!.instruction_text, '');
  assert.equal(rows[1]!.assigned_agent, 'codex');
});

test('promoting a future objective splices it into the draft slot and cascades positions', async () => {
  const project = await createProject({ name: 'Promote Future Splice' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'Objective 1' });
  const objectiveIds = [mission.objectives[0]!.id];

  for (let index = 2; index <= 5; index += 1) {
    const objective = await createObjective({
      missionId: mission.id,
      instructionText: `Objective ${index}`
    });
    objectiveIds.push(objective.id);
  }

  const promoted = await createObjective({
    missionId: mission.id,
    instructionText: 'Inserted objective'
  });

  const [firstId, secondId, thirdId, fourthId, fifthId] = objectiveIds;
  db.prepare(`UPDATE objectives SET state = 'complete', position = 0 WHERE id = ?`).run(firstId);
  db.prepare(`UPDATE objectives SET state = 'complete', position = 1 WHERE id = ?`).run(secondId);
  db.prepare(`UPDATE objectives SET state = 'draft', position = 2 WHERE id = ?`).run(thirdId);
  db.prepare(`UPDATE objectives SET state = 'future', position = 3 WHERE id = ?`).run(fourthId);
  db.prepare(`UPDATE objectives SET state = 'future', position = 4 WHERE id = ?`).run(fifthId);
  db.prepare(`UPDATE objectives SET state = 'future', position = 5 WHERE id = ?`).run(promoted.id);

  await updateObjective(promoted.id, { state: 'draft' });

  const rows = db
    .prepare(
      `SELECT id, instruction_text, state, position
       FROM objectives
       WHERE mission_id = ? AND deleted_at IS NULL
       ORDER BY position ASC`
    )
    .all(mission.id) as Array<{
    id: string;
    instruction_text: string;
    state: string;
    position: number;
  }>;

  assert.deepEqual(
    rows.map(row => ({
      text: row.instruction_text,
      state: row.state,
      position: row.position
    })),
    [
      { text: 'Objective 1', state: 'complete', position: 0 },
      { text: 'Objective 2', state: 'complete', position: 1 },
      { text: 'Inserted objective', state: 'draft', position: 2 },
      { text: 'Objective 3', state: 'future', position: 3 },
      { text: 'Objective 4', state: 'future', position: 4 },
      { text: 'Objective 5', state: 'future', position: 5 }
    ]
  );
});

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
