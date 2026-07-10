import { listChangedFilesForReview, listRationalesForReview } from '@overlord/core/service/changes';
import {
  claimNextExecutionRequest,
  clearExecutionRequests,
  createExecutionRequest,
  expireStaleExecutionRequests,
  listExecutionRequests,
  markExecutionLaunched,
  markExecutionLaunching
} from '@overlord/core/service/execution-requests';
import { createMissionWithObjectives } from '@overlord/core/service/missions';
import { addProjectResource, createProject } from '@overlord/core/service/projects';
import { attachSession, deliverSession, updateSession } from '@overlord/core/service/protocol';
import { newId } from '@overlord/core/service/util';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createSeededCliContext } from './support/seeded-context.ts';

async function createContext() {
  return createSeededCliContext();
}

test('execution request queue rejects when no primary resource is linked', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'No Primary Resource Test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue without a primary resource' }]
  });

  await assert.rejects(
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

  await db.close();
});

test('execution request queue rejects when the primary resource path is missing', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Missing Primary Path Test' });
  const resourcePath = path.join(process.cwd(), '.overlord-missing-primary-test');
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: resourcePath,
    isPrimary: true
  });
  // Linking scaffolds the directory on disk; simulate it disappearing afterward
  // so the primary-resource guard sees a `missing` status.
  rmSync(resourcePath, { recursive: true, force: true });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue with a missing primary path' }]
  });

  await assert.rejects(
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

  await db.close();
});

test('claiming a queued request fails when the primary resource is missing', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Claim Missing Primary Test' });
  const resourcePath = path.join(process.cwd(), '.overlord-missing-primary-claim-test');
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: resourcePath,
    isPrimary: true
  });
  // Linking scaffolds the directory; remove it so the claim sees it missing.
  rmSync(resourcePath, { recursive: true, force: true });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Queued before the primary path disappeared' }]
  });

  const requestId = newId();
  const now = new Date().toISOString();
  await ctx.db.run(
    `INSERT INTO execution_requests
       (id, workspace_id, project_id, mission_id, objective_id, requested_agent,
        launch_mode, launch_flags_json, target_kind, requested_source, status,
        created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 'codex', 'run', '{}', 'local', 'webapp', 'queued', ?, ?, 1)`,
    [requestId, ctx.workspace.id, project.id, mission.id, objectives[0]?.id, now, now]
  );

  assert.equal(await claimNextExecutionRequest({ ctx }), null);

  const failed = (await ctx.db.get(
    `SELECT status, last_error FROM execution_requests WHERE id = ?`,
    [requestId]
  )) as { status: string; last_error: string };
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /Primary working directory is missing/);

  await db.close();
});

test('execution request queue can create, claim, launch, and clear active requests', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Runner Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Run the next objective' }]
  });

  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(request.status, 'queued');

  const duplicate = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(duplicate.id, request.id);

  const claimed = await claimNextExecutionRequest({ ctx });
  assert.ok(claimed);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.workingDirectory, process.cwd());
  assert.ok(claimed.claimedByDeviceId);
  assert.ok(claimed.claimedByExecutionTargetId);
  assert.ok(claimed.claimExpiresAt);

  const claimEvent = await ctx.db.get(
    `SELECT id FROM mission_events
        WHERE mission_id = ? AND objective_id = ? AND type = 'status_change'
          AND summary = 'Runner claimed execution request.'`,
    [mission.id, objectives[0]?.id]
  );
  assert.ok(claimEvent, 'claim should write a mission status event');

  const claimChange = (await ctx.db.get(
    `SELECT changed_fields_json FROM entity_changes
        WHERE entity_type = 'execution_request' AND entity_id = ? AND operation = 'update'
        ORDER BY occurred_at DESC LIMIT 1`,
    [claimed.id]
  )) as { changed_fields_json: string } | undefined;
  assert.ok(claimChange, 'claim should write an entity change');
  assert.match(claimChange.changed_fields_json, /claimed_by_device_id/);

  const launching = await markExecutionLaunching({ ctx, requestId: claimed.id });
  assert.equal(launching.status, 'launching');
  const launched = await markExecutionLaunched({ ctx, requestId: claimed.id });
  assert.equal(launched.status, 'launched');

  const active = await listExecutionRequests({ ctx });
  assert.equal(active.length, 0);

  const second = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(second.status, 'queued');
  assert.equal((await clearExecutionRequests({ ctx, objectiveId: objectives[0]?.id })).cleared, 1);

  await db.close();
});

test('execution request state machine rejects illegal launch transitions', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Runner Illegal Transition Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Reject illegal transition' }]
  });

  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });

  await assert.rejects(
    () => markExecutionLaunched({ ctx, requestId: request.id }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'invalid_execution_request_transition'
  );

  await db.close();
});

test('stale claims expire with event and change records', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Runner Claim Expiry Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Expire stale claim' }]
  });
  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  const claimed = await claimNextExecutionRequest({ ctx });
  assert.equal(claimed?.id, request.id);

  await ctx.db.run(`UPDATE execution_requests SET claim_expires_at = ? WHERE id = ?`, [
    '2000-01-01T00:00:00.000Z',
    request.id
  ]);

  assert.equal((await expireStaleExecutionRequests({ ctx })).expired, 1);
  const expired = (await ctx.db.get(
    `SELECT status, last_error FROM execution_requests WHERE id = ?`,
    [request.id]
  )) as { status: string; last_error: string };
  assert.equal(expired.status, 'expired');
  assert.match(expired.last_error, /expired before launch started/);

  await db.close();
});

test('launched requests expire when no agent attaches before the deadline', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Runner Launch Expiry Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Expire launched-but-unattached' }]
  });
  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  const claimed = await claimNextExecutionRequest({ ctx });
  assert.equal(claimed?.id, request.id);
  await markExecutionLaunching({ ctx, requestId: request.id });
  await markExecutionLaunched({ ctx, requestId: request.id });

  // The terminal opened but the agent never attached: drive launch_completed_at
  // past the attach deadline while launched_session_id stays null.
  await ctx.db.run(`UPDATE execution_requests SET launch_completed_at = ? WHERE id = ?`, [
    '2000-01-01T00:00:00.000Z',
    request.id
  ]);

  assert.equal((await expireStaleExecutionRequests({ ctx })).expired, 1);
  const expired = (await ctx.db.get(
    `SELECT status, last_error FROM execution_requests WHERE id = ?`,
    [request.id]
  )) as { status: string; last_error: string };
  assert.equal(expired.status, 'expired');
  assert.match(expired.last_error, /expired before the launched agent attached/);

  await db.close();
});

test('a launched request linked to a session is not expired', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Runner Launch Linked Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Linked launched request survives expiry' }]
  });
  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  await claimNextExecutionRequest({ ctx });
  await markExecutionLaunching({ ctx, requestId: request.id });
  await markExecutionLaunched({ ctx, requestId: request.id });

  // The agent attached: launched_session_id is populated, so even a stale
  // launch_completed_at must not trip the launched-without-attach sweep.
  await attachSession({
    ctx,
    missionId: mission.displayId,
    agentIdentifier: 'codex',
    executionRequestId: request.id
  });
  await ctx.db.run(`UPDATE execution_requests SET launch_completed_at = ? WHERE id = ?`, [
    '2000-01-01T00:00:00.000Z',
    request.id
  ]);

  assert.equal((await expireStaleExecutionRequests({ ctx })).expired, 0);
  const survived = (await ctx.db.get(`SELECT status FROM execution_requests WHERE id = ?`, [
    request.id
  ])) as { status: string };
  assert.equal(survived.status, 'launched');

  await db.close();
});

test('attach links a launched execution request to the created session', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Attach Request Link Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Attach should link request' }]
  });
  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  const claimed = await claimNextExecutionRequest({ ctx });
  assert.equal(claimed?.id, request.id);
  await markExecutionLaunching({ ctx, requestId: request.id });

  const attached = await attachSession({
    ctx,
    missionId: mission.displayId,
    agentIdentifier: 'codex',
    executionRequestId: request.id
  });

  const linked = (await ctx.db.get(
    `SELECT launched_session_id FROM execution_requests WHERE id = ?`,
    [request.id]
  )) as { launched_session_id: string | null };
  assert.equal(linked.launched_session_id, attached.session.id);

  await db.close();
});

test('runner does not claim a queued request for a soft-deleted objective', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Deleted Objective Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Objective to be removed' }]
  });

  const request = await createExecutionRequest({
    ctx,
    missionId: mission.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(request.status, 'queued');

  // Mirror a UI disconnect/delete that soft-deletes the objective. The runner
  // must skip the orphaned request rather than launch retired work.
  await ctx.db.run(`UPDATE objectives SET deleted_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    objectives[0]?.id
  ]);

  assert.equal(await claimNextExecutionRequest({ ctx }), null);

  await db.close();
});

test('delivery auto-advance queues next objective when enabled', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Auto Advance Test' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
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
  await ctx.db.run(
    `UPDATE objectives
          SET state = 'submitted', assigned_agent = 'claude', model = 'claude-opus-4-8',
              reasoning_effort = 'high'
        WHERE id = ?`,
    [objectives[0]?.id]
  );

  const attached = await attachSession({ ctx, missionId: mission.displayId });
  await deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'First objective complete'
  });

  const requests = await listExecutionRequests({ ctx });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.objectiveId, objectives[1]?.id);
  assert.equal(requests[0]?.requestedSource, 'auto_advance');
  // Execution uses the agent from the db, inherited from the delivered objective.
  assert.equal(requests[0]?.requestedAgent, 'claude');
  assert.equal(requests[0]?.requestedModel, 'claude-opus-4-8');
  assert.equal(requests[0]?.requestedReasoningEffort, 'high');

  // The inherited selection is persisted onto the next objective so the launch
  // button (which reads the db) reflects what actually executed.
  const nextObjective = (await ctx.db.get(
    `SELECT assigned_agent, model, reasoning_effort FROM objectives WHERE id = ?`,
    [objectives[1]?.id]
  )) as {
    assigned_agent: string | null;
    model: string | null;
    reasoning_effort: string | null;
  };
  assert.equal(nextObjective.assigned_agent, 'claude');
  assert.equal(nextObjective.model, 'claude-opus-4-8');
  assert.equal(nextObjective.reasoning_effort, 'high');

  await db.close();
});

test('delivery auto-advance keeps the next objective explicit agent', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Auto Advance Explicit Agent' });
  await addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: process.cwd(),
    isPrimary: true
  });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective', autoAdvance: true }
    ]
  });
  await ctx.db.run(
    `UPDATE objectives SET state = 'submitted', assigned_agent = 'codex' WHERE id = ?`,
    [objectives[0]?.id]
  );
  // The next objective was deliberately assigned a different agent; auto-advance
  // must honor its own assignment instead of inheriting the delivered one.
  await ctx.db.run(`UPDATE objectives SET assigned_agent = 'claude' WHERE id = ?`, [
    objectives[1]?.id
  ]);

  const attached = await attachSession({ ctx, missionId: mission.displayId });
  await deliverSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'First objective complete'
  });

  const requests = await listExecutionRequests({ ctx });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.objectiveId, objectives[1]?.id);
  assert.equal(requests[0]?.requestedAgent, 'claude');

  await db.close();
});

test('change review reports missing and covered rationales', async () => {
  const { db, ctx } = await createContext();
  const project = await createProject({ ctx, name: 'Change Review Test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Track changes' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);
  const attached = await attachSession({ ctx, missionId: mission.displayId });

  await updateSession({
    ctx,
    missionId: mission.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Changed files',
    changedFiles: [{ filePath: 'src/example.ts', vcsStatus: 'M' }]
  });
  assert.equal(
    (
      await listChangedFilesForReview({ ctx, missionId: mission.displayId, includeCurrent: false })
    )[0]?.coverage,
    'missing_rationale'
  );

  await deliverSession({
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

  const files = await listChangedFilesForReview({
    ctx,
    missionId: mission.displayId,
    includeCurrent: false
  });
  assert.equal(files[0]?.coverage, 'covered');
  assert.equal((await listRationalesForReview({ ctx, missionId: mission.displayId })).length, 1);

  await db.close();
});
