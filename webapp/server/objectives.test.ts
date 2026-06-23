import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-objectives-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db, WORKSPACE, setActiveWorkspaceUser, nowIso, newId } = await import('./db.ts');
const { createMission, createProject, createObjective, updateObjective } =
  await import('./repository.ts');
const { updateLaunchPreference } = await import('./launch.ts');
const { ApiError } = await import('./errors.ts');

// A fresh local DB no longer seeds a persistent operator (contract 0.21), so the
// launch-preference owner must be created and made the active actor.
{
  const userId = newId();
  const operatorId = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, 'Test Operator', 'objectives-op@overlord.local', 0, ?, ?)`
  ).run(userId, now, now);
  db.prepare(
    `INSERT INTO workspace_users (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'test:op', 'active', '{}', ?, ?, 1)`
  ).run(operatorId, WORKSPACE.id, userId, now, now);
  setActiveWorkspaceUser(operatorId);
}

test('clearing a draft objective instruction to empty leaves it blank instead of erroring', () => {
  const project = createProject({ name: 'Clear Instruction Test' });
  const mission = createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = mission.objectives[0]!.id;

  const updated = updateObjective(objectiveId, { instructionText: '   ' });

  assert.equal(updated.instructionText, '');
});

test('clearing a submitted objective instruction to empty is still rejected', () => {
  const project = createProject({ name: 'Clear Submitted Instruction Test' });
  const mission = createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = mission.objectives[0]!.id;
  updateObjective(objectiveId, { state: 'submitted' });

  assert.throws(
    () => updateObjective(objectiveId, { instructionText: '   ' }),
    (err: unknown) => err instanceof ApiError && err.status === 400
  );
});

test('new draft objectives inherit the project last-used agent', () => {
  const project = createProject({ name: 'Default Agent Objectives' });
  updateLaunchPreference(project.id, {
    selectedAgent: 'claude',
    selectedModel: 'claude-opus-4-8',
    selectedReasoningEffort: 'high'
  });

  // The mission's first objective is created through the same insert path and must
  // record the launch selection so the button and execution read it from the db.
  const mission = createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  const firstObjective = mission.objectives[0]!;
  assert.equal(firstObjective.assignedAgent, 'claude');
  assert.equal(firstObjective.model, 'claude-opus-4-8');
  assert.equal(firstObjective.reasoningEffort, 'high');

  // A blank draft slot added afterwards (the add-objective affordance) also stamps
  // the agent rather than leaving it null for auto-advance to misread.
  const added = createObjective({ missionId: mission.id, instructionText: '' });
  assert.equal(added.assignedAgent, 'claude');
  assert.equal(added.model, 'claude-opus-4-8');
  assert.equal(added.reasoningEffort, 'high');
});

test('new draft objectives leave the agent unset without a launch preference', () => {
  const project = createProject({ name: 'No Preference Objectives' });
  const mission = createMission({ projectId: project.id, firstObjective: 'Do the thing' });
  assert.equal(mission.objectives[0]!.assignedAgent, null);
});

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
