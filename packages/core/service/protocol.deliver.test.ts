import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listChangedFilesForReview } from './changes.js';
import { createServiceContext } from './context.js';
import { createMissionWithObjectives, insertObjective } from './missions.js';
import { addProjectResource, createProject } from './projects.js';
import {
  askQuestion,
  attachSession,
  deliverSession,
  resumeFollowUp,
  updateSession
} from './protocol.js';
import { nowIso } from './util.js';

async function setup() {
  const db = createSqliteClient(openInMemoryDatabase());
  const ctx = await createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

async function submittedMission(
  ctx: Awaited<ReturnType<typeof createServiceContext>>,
  name: string
) {
  const project = await createProject({ ctx, name });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: `Work for ${name}` }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);
  return { project, mission, objectiveId: objectives[0]?.id as string };
}

async function entityChangesFor(
  ctx: Awaited<ReturnType<typeof createServiceContext>>,
  entityType: string,
  entityId: string
) {
  return (await ctx.db.all(
    `SELECT entity_type, entity_id, operation, entity_revision, changed_fields_json,
            project_id, mission_id, objective_id
       FROM entity_changes
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY seq ASC`,
    [entityType, entityId]
  )) as Array<{
    entity_type: string;
    entity_id: string;
    operation: string;
    entity_revision: number | null;
    changed_fields_json: string;
    project_id: string | null;
    mission_id: string | null;
    objective_id: string | null;
  }>;
}

function changedFields(row: { changed_fields_json: string }): string[] {
  return JSON.parse(row.changed_fields_json) as string[];
}

describe('deliverSession mechanical change capture', () => {
  it('records objective change feed coverage when attach moves an objective to executing', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'Attach Feed');

    await attachSession({ ctx, missionId: mission.displayId, agentIdentifier: 'codex' });

    const changes = await entityChangesFor(ctx, 'objective', objectiveId);
    const attachChange = changes.find(change => change.operation === 'update');
    assert.ok(attachChange);
    assert.equal(attachChange.project_id, mission.projectId);
    assert.equal(attachChange.mission_id, mission.id);
    assert.equal(attachChange.objective_id, objectiveId);
    assert.deepEqual(changedFields(attachChange), ['state', 'assigned_agent']);

    await db.close();
  });

  it('keeps resume follow-up objective changes in the durable change feed', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'Resume Feed');
    const attached = await attachSession({ ctx, missionId: mission.displayId });
    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Delivered before follow-up.'
    });

    await resumeFollowUp({ ctx, missionId: mission.displayId, objectiveId });

    const changes = await entityChangesFor(ctx, 'objective', objectiveId);
    const latestUpdate = changes.filter(change => change.operation === 'update').at(-1);
    assert.ok(latestUpdate);
    assert.deepEqual(changedFields(latestUpdate), ['state', 'completed_at']);

    await db.close();
  });

  it('records delivery workflow state transitions in the durable change feed', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'Deliver Feed');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    const delivered = await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Delivered with feed coverage.'
    });

    const eventChanges = await entityChangesFor(ctx, 'mission_event', delivered.eventId);
    assert.equal(eventChanges.length, 1);
    assert.equal(eventChanges[0]?.operation, 'insert');
    assert.equal(eventChanges[0]?.mission_id, mission.id);
    assert.equal(eventChanges[0]?.objective_id, objectiveId);

    const objectiveChanges = await entityChangesFor(ctx, 'objective', objectiveId);
    const completeChange = objectiveChanges.find(
      change =>
        change.operation === 'update' &&
        changedFields(change).includes('state') &&
        changedFields(change).includes('completed_at')
    );
    assert.ok(completeChange);

    const sessionChanges = await entityChangesFor(ctx, 'agent_session', attached.session.id);
    const deliveredSessionChange = sessionChanges.find(
      change =>
        change.operation === 'update' &&
        changedFields(change).includes('delivery_state') &&
        changedFields(change).includes('phase') &&
        changedFields(change).includes('ended_at')
    );
    assert.ok(deliveredSessionChange);

    await db.close();
  });

  it('records blocking question mission events in the durable change feed', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'Ask Feed');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    const asked = await askQuestion({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      question: 'Which path should I take?'
    });

    const eventChanges = await entityChangesFor(ctx, 'mission_event', asked.eventId);
    assert.equal(eventChanges.length, 1);
    assert.equal(eventChanges[0]?.operation, 'insert');
    assert.equal(eventChanges[0]?.project_id, mission.projectId);
    assert.equal(eventChanges[0]?.mission_id, mission.id);
    assert.equal(eventChanges[0]?.objective_id, objectiveId);

    await db.close();
  });

  it('promotes a future objective over a blank draft placeholder after delivery', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Deliver Future Before Placeholder' });
    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Complete current objective' }]
    });
    const attached = await attachSession({ ctx, missionId: mission.displayId });
    const placeholder = attached.objectives.find(objective => objective.state === 'draft');
    assert.ok(placeholder);

    const future = await insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: 'Continue with real objective',
      state: 'draft'
    });
    assert.equal(future.state, 'future');

    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Delivered current objective.'
    });

    const rows = (await ctx.db.all(
      `SELECT id, instruction_text, state
         FROM objectives
         WHERE mission_id = ? AND deleted_at IS NULL
         ORDER BY position ASC`,
      [mission.id]
    )) as Array<{ id: string; instruction_text: string; state: string }>;
    assert.deepEqual(
      rows.map(row => row.state),
      ['complete', 'draft']
    );
    assert.equal(rows[1]?.id, future.id);
    assert.equal(rows[1]?.instruction_text, 'Continue with real objective');

    const placeholderRow = (await ctx.db.get(`SELECT deleted_at FROM objectives WHERE id = ?`, [
      placeholder.id
    ])) as { deleted_at: string | null };
    assert.ok(placeholderRow.deleted_at);

    await db.close();
  });

  it('stamps the resolved launch config onto the auto-advanced next request', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Auto Advance Launch Flags' });
    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'First objective' },
        { objective: 'Second objective', autoAdvance: true }
      ]
    });
    const secondObjectiveId = objectives[1]?.id as string;

    // createExecutionRequest resolves the working directory from the project's
    // primary resource, so the auto-advance path needs one linked.
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-auto-advance-')),
      isPrimary: true
    });

    // Workspace catalog launch default for the agent — the lowest-priority
    // launch-config source the shared resolver must still honor on the
    // auto-advance path (previously this path stamped an empty config).
    await ctx.db.run(`UPDATE workspaces SET settings_json = ? WHERE id = ?`, [
      JSON.stringify({
        agentCatalog: {
          agents: {
            claude: { launchDefaults: { preCommand: 'nvm use 20', flags: ['--verbose'] } }
          }
        }
      }),
      ctx.workspace.id
    ]);

    await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);
    const attached = await attachSession({
      ctx,
      missionId: mission.displayId,
      agentIdentifier: 'claude'
    });

    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Delivered first objective; auto-advance the second.'
    });

    const request = (await ctx.db.get(
      `SELECT launch_flags_json, requested_agent, requested_source
         FROM execution_requests
        WHERE objective_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [secondObjectiveId]
    )) as
      | { launch_flags_json: string; requested_agent: string | null; requested_source: string }
      | undefined;
    assert.ok(request, 'auto-advance should queue an execution request for the next objective');
    assert.equal(request.requested_source, 'auto_advance');
    // The agent is inherited from the just-delivered objective so the launch
    // config can be resolved for it.
    assert.equal(request.requested_agent, 'claude');
    const flags = JSON.parse(request.launch_flags_json) as {
      preCommand?: string;
      flags?: string[];
    };
    assert.equal(flags.preCommand, 'nvm use 20');
    assert.deepEqual(flags.flags, ['--verbose']);

    await db.close();
  });

  it('records run-supplied changed files and enforces rationale coverage', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Deliver Capture');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    // The CLI injects the VCS delta as changedFiles at deliver; a changed file
    // without a rationale must block delivery.
    await assert.rejects(
      async () =>
        await deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Deliver without rationale',
          changedFiles: [{ filePath: 'src/feature.ts', vcsStatus: 'M' }]
        }),
      /Missing change rationale for src\/feature\.ts/
    );

    // With the rationale, delivery succeeds and the file is recorded and covered.
    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Deliver with rationale',
      changedFiles: [{ filePath: 'src/feature.ts', vcsStatus: 'M' }],
      changeRationales: [
        {
          file_path: 'src/feature.ts',
          label: 'Feature',
          summary: 'Added feature.',
          why: 'Required by the objective.',
          impact: 'New behavior ships.'
        }
      ]
    });

    const files = await listChangedFilesForReview({
      ctx,
      missionId: mission.displayId,
      includeCurrent: false
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filePath, 'src/feature.ts');
    assert.equal(files[0]?.coverage, 'covered');

    await db.close();
  });

  it('accepts the camelCase filePath alias for a rationale', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Rationale Alias');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    // An agent that generalizes the changed-files `filePath` casing to a
    // rationale must no longer be rejected; the alias normalizes to file_path
    // and satisfies coverage for the same path.
    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Deliver with camelCase rationale path',
      changedFiles: [{ filePath: 'src/alias.ts', vcsStatus: 'M' }],
      changeRationales: [
        {
          filePath: 'src/alias.ts',
          label: 'Alias',
          summary: 'Used camelCase path.',
          why: 'Matches the changed-files casing.',
          impact: 'Rationale is accepted without re-casing.'
        }
      ]
    });

    const files = await listChangedFilesForReview({
      ctx,
      missionId: mission.displayId,
      includeCurrent: false
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filePath, 'src/alias.ts');
    assert.equal(files[0]?.coverage, 'covered');

    await db.close();
  });

  it('skips rationale coverage when the run declares no file changes', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'No File Changes');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    // A changed file was observed earlier, but the explicit no-file-changes
    // declaration must skip coverage so a genuine no-op run can deliver.
    await updateSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Observed a leftover edit',
      changedFiles: [{ filePath: 'src/leftover.ts', vcsStatus: 'M' }]
    });

    const result = await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'No files changed in this run.',
      noFileChanges: true
    });
    assert.ok(result.deliveryId);

    const objective = (await ctx.db.get(`SELECT state FROM objectives WHERE id = ?`, [
      objectiveId
    ])) as { state: string };
    assert.equal(objective.state, 'complete');

    await db.close();
  });

  it('allows per-file rationale skips for changes the agent did not make', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Skip Rationale');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Deliver with skip override',
      changedFiles: [
        { filePath: 'src/mine.ts', vcsStatus: 'M' },
        { filePath: 'webapp/package.json', vcsStatus: 'M' }
      ],
      changeRationales: [
        {
          file_path: 'src/mine.ts',
          label: 'Mine',
          summary: 'My change.',
          why: 'Required.',
          impact: 'Ships.'
        }
      ],
      skipRationaleFor: [
        {
          file_path: 'webapp/package.json',
          reason: 'Concurrent host-side edit; not made by this mission.'
        }
      ]
    });

    const files = await listChangedFilesForReview({
      ctx,
      missionId: mission.displayId,
      includeCurrent: false
    });
    assert.equal(files.find(file => file.filePath === 'src/mine.ts')?.coverage, 'covered');
    assert.equal(files.find(file => file.filePath === 'webapp/package.json')?.coverage, 'skipped');

    await db.close();
  });

  it('rejects skip and rationale for the same file', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Skip Conflict');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    await assert.rejects(
      async () =>
        await deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Conflicting skip and rationale',
          changedFiles: [{ filePath: 'src/conflict.ts', vcsStatus: 'M' }],
          changeRationales: [
            {
              file_path: 'src/conflict.ts',
              label: 'Conflict',
              summary: 'Changed.',
              why: 'Needed.',
              impact: 'Ships.'
            }
          ],
          skipRationaleFor: [{ file_path: 'src/conflict.ts', reason: 'Not mine.' }]
        }),
      /Cannot skip and provide a rationale for the same file/
    );

    await db.close();
  });

  it('enforces coverage objective-scoped across no-session records', async () => {
    const { db, ctx } = await setup();
    const { project, mission, objectiveId } = await submittedMission(ctx, 'Objective Scope');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    // A changed file recorded with no session (record-work style) for this
    // objective. Under the old session-scoped check a different session's
    // delivery would miss it; objective-scoped coverage must still require it.
    const now = nowIso();
    await ctx.db.run(
      `INSERT INTO changed_files
           (id, workspace_id, project_id, mission_id, objective_id, session_id, file_path, vcs_status,
            current_diff_state, first_observed_at, last_observed_at, observed_metadata_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'M', 'present', ?, ?, '{}', ?, ?, 1)`,
      [
        'cf-scope-1',
        ctx.workspace.id,
        project.id,
        mission.id,
        objectiveId,
        'src/shared.ts',
        now,
        now,
        now,
        now
      ]
    );

    await assert.rejects(
      async () =>
        await deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Deliver objective'
        }),
      /Missing change rationale for src\/shared\.ts/
    );

    await db.close();
  });
});
