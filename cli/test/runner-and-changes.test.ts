import { migrateDatabase } from '@overlord/database';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { listChangedFilesForReview, listRationalesForReview } from '../../src/service/changes.ts';
import { createServiceContext } from '../../src/service/context.ts';
import {
  claimNextExecutionRequest,
  clearExecutionRequests,
  createExecutionRequest,
  listExecutionRequests,
  markExecutionLaunched,
  markExecutionLaunching
} from '../../src/service/execution-requests.ts';
import { createMissionWithObjectives } from '../../src/service/missions.ts';
import { addProjectResource, createProject } from '../../src/service/projects.ts';
import { attachSession, deliverSession, updateSession } from '../../src/service/protocol.ts';
import { newId } from '../../src/service/util.ts';

function createContext() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return { db, ctx: createServiceContext({ db, source: 'cli' }) };
}

test('execution request queue rejects when no primary resource is linked', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'No Primary Resource Test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue without a primary resource' }]
  });

  assert.throws(
    () =>
      createExecutionRequest({
        ctx,
        missionId: mission.displayId,
        objectiveId: objectives[0]?.id,
        requestedAgent: 'codex',
        requestedSource: 'cli'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('No primary resource is linked') &&
      'code' in error &&
      (error as { code: string }).code === 'primary_resource_not_connected'
  );

  db.close();
});

test('execution request queue rejects when the primary resource path is missing', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Missing Primary Path Test' });
  const resourcePath = path.join(process.cwd(), '.overlord-missing-primary-test');
  addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: resourcePath,
    isPrimary: true
  });
  // Linking scaffolds the directory on disk; simulate it disappearing afterward
  // so the primary-resource guard sees a `missing` status.
  rmSync(resourcePath, { recursive: true, force: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue with a missing primary path' }]
  });

  assert.throws(
    () =>
      createExecutionRequest({
        ctx,
        missionId: mission.displayId,
        objectiveId: objectives[0]?.id,
        requestedAgent: 'codex',
        requestedSource: 'cli'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('Primary working directory is missing') &&
      'code' in error &&
      (error as { code: string }).code === 'primary_resource_not_connected'
  );

  db.close();
});

test('claiming a queued request fails when the primary resource is missing', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Claim Missing Primary Test' });
  const resourcePath = path.join(process.cwd(), '.overlord-missing-primary-claim-test');
  addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: resourcePath,
    isPrimary: true
  });
  // Linking scaffolds the directory; remove it so the claim sees it missing.
  rmSync(resourcePath, { recursive: true, force: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Queued before the primary path disappeared' }]
  });

  const requestId = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_requests
       (id, workspace_id, project_id, mission_id, objective_id, requested_agent,
        launch_mode, launch_flags_json, target_kind, requested_source, status,
        created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 'codex', 'run', '{}', 'local', 'webapp', 'queued', ?, ?, 1)`
  ).run(requestId, ctx.workspace.id, project.id, mission.id, objectives[0]?.id, now, now);

  assert.equal(claimNextExecutionRequest({ ctx }), null);

  const failed = db
    .prepare(`SELECT status, last_error FROM execution_requests WHERE id = ?`)
    .get(requestId) as { status: string; last_error: string };
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /Primary working directory is missing/);

  db.close();
});

test('execution request queue can create, claim, launch, and clear active requests', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Runner Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Run the next objective' }]
  });

  const request = createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(request.status, 'queued');

  const duplicate = createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(duplicate.id, request.id);

  const claimed = claimNextExecutionRequest({ ctx });
  assert.ok(claimed);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.workingDirectory, process.cwd());

  const launching = markExecutionLaunching({ ctx, requestId: claimed.id });
  assert.equal(launching.status, 'launching');
  const launched = markExecutionLaunched({ ctx, requestId: claimed.id });
  assert.equal(launched.status, 'launched');

  const active = listExecutionRequests({ ctx });
  assert.equal(active.length, 0);

  const second = createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(second.status, 'queued');
  assert.equal(clearExecutionRequests({ ctx, objectiveId: objectives[0]?.id }).cleared, 1);

  db.close();
});

test('runner does not claim a queued request for a soft-deleted objective', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Deleted Objective Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Objective to be removed' }]
  });

  const request = createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(request.status, 'queued');

  // Mirror a UI disconnect/delete that soft-deletes the objective. The runner
  // must skip the orphaned request rather than launch retired work.
  ctx.db
    .prepare(`UPDATE objectives SET deleted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), objectives[0]?.id);

  assert.equal(claimNextExecutionRequest({ ctx }), null);

  db.close();
});

test('delivery auto-advance queues next objective when enabled', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Auto Advance Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective', autoAdvance: true }
    ]
  });
  // The first objective ran with an explicit agent/model (as a launch would
  // persist). The auto-advanced draft has no agent of its own and must inherit
  // it rather than fall back to the runner's hardcoded default.
  ctx.db
    .prepare(
      `UPDATE objectives
          SET state = 'submitted', assigned_agent = 'claude', model = 'claude-opus-4-8',
              reasoning_effort = 'high'
        WHERE id = ?`
    )
    .run(objectives[0]?.id);

  const attached = attachSession({ ctx, missionId: mission.displayId });
  deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'First objective complete'
  });

  const requests = listExecutionRequests({ ctx });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.objectiveId, objectives[1]?.id);
  assert.equal(requests[0]?.requestedSource, 'auto_advance');
  // Execution uses the agent from the db, inherited from the delivered objective.
  assert.equal(requests[0]?.requestedAgent, 'claude');
  assert.equal(requests[0]?.requestedModel, 'claude-opus-4-8');
  assert.equal(requests[0]?.requestedReasoningEffort, 'high');

  // The inherited selection is persisted onto the next objective so the launch
  // button (which reads the db) reflects what actually executed.
  const nextObjective = ctx.db
    .prepare(`SELECT assigned_agent, model, reasoning_effort FROM objectives WHERE id = ?`)
    .get(objectives[1]?.id) as {
    assigned_agent: string | null;
    model: string | null;
    reasoning_effort: string | null;
  };
  assert.equal(nextObjective.assigned_agent, 'claude');
  assert.equal(nextObjective.model, 'claude-opus-4-8');
  assert.equal(nextObjective.reasoning_effort, 'high');

  db.close();
});

test('delivery auto-advance keeps the next objective explicit agent', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Auto Advance Explicit Agent' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective', autoAdvance: true }
    ]
  });
  ctx.db
    .prepare(`UPDATE objectives SET state = 'submitted', assigned_agent = 'codex' WHERE id = ?`)
    .run(objectives[0]?.id);
  // The next objective was deliberately assigned a different agent; auto-advance
  // must honor its own assignment instead of inheriting the delivered one.
  ctx.db
    .prepare(`UPDATE objectives SET assigned_agent = 'claude' WHERE id = ?`)
    .run(objectives[1]?.id);

  const attached = attachSession({ ctx, missionId: mission.displayId });
  deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'First objective complete'
  });

  const requests = listExecutionRequests({ ctx });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.objectiveId, objectives[1]?.id);
  assert.equal(requests[0]?.requestedAgent, 'claude');

  db.close();
});

test('change review reports missing and covered rationales', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Change Review Test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Track changes' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);
  const attached = attachSession({ ctx, missionId: mission.displayId });

  updateSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Changed files',
    changedFiles: [{ filePath: 'src/example.ts', vcsStatus: 'M' }]
  });
  assert.equal(
    listChangedFilesForReview({ ctx, missionId: mission.displayId, includeCurrent: false })[0]
      ?.coverage,
    'missing_rationale'
  );

  deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Delivered tracked change',
    changeRationales: [
      {
        file_path: 'src/example.ts',
        label: 'Example change',
        summary: 'Updated the example.',
        why: 'Required for the test.',
        impact: 'Review shows covered rationale.'
      }
    ]
  });

  const files = listChangedFilesForReview({
    ctx,
    missionId: mission.displayId,
    includeCurrent: false
  });
  assert.equal(files[0]?.coverage, 'covered');
  assert.equal(listRationalesForReview({ ctx, missionId: mission.displayId }).length, 1);

  db.close();
});
