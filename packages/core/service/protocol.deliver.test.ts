import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listChangedFilesForReview } from './changes.js';
import type { ServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import { createMissionWithObjectives, insertObjective } from './missions.js';
import { addProjectResource, createProject } from './projects.js';
import {
  askQuestion,
  attachSession,
  deliverSession,
  resumeFollowUp,
  updateSession
} from './protocol.js';
import { createSeededServiceContext } from './test-helpers.js';
import { nowIso } from './util.js';

async function setup() {
  return createSeededServiceContext({ source: 'cli' });
}

async function submittedMission(ctx: ServiceContext, name: string) {
  const project = await createProject({ ctx, name });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: `Work for ${name}` }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);
  return { project, mission, objectiveId: objectives[0]?.id as string };
}

async function entityChangesFor(ctx: ServiceContext, entityType: string, entityId: string) {
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

  it('stores normalized delivery evidence with a deterministic fallback and filters Git and QA actions', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Delivery Evidence');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    const delivered = await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Implemented the durable delivery evidence pipeline.',
      payloadJson: {
        deliveryReport: {
          schemaVersion: 1,
          agentReport: {
            humanActions: [
              {
                action: 'Add the production Gemini credential before enabling composition.',
                reason: 'Phase 3 composition needs an operator-managed provider credential.',
                category: 'environment',
                blocking: false
              },
              { action: 'git push the feature branch', category: 'other' },
              { action: 'Review the code', category: 'other' },
              { action: 'Run the test suite', category: 'other' }
            ],
            tradeoffsMade: [
              {
                decision: 'Persist a deterministic fallback before AI composition.',
                alternativesConsidered: [
                  'Block delivery on Gemini',
                  'Require agents to compose display Markdown'
                ],
                rationale: 'Delivery must remain durable when a provider is unavailable.',
                impact: 'Phase 1 displays agent-authored summary text until composition ships.'
              }
            ],
            knownRisks: ['AI composition is intentionally deferred to Phase 3.'],
            deferredWork: ['Delivery detail UI is Phase 2.'],
            assumptions: ['The existing payload_json field remains the delivery extension point.']
          }
        }
      }
    });

    const row = (await ctx.db.get(`SELECT payload_json FROM deliveries WHERE id = ?`, [
      delivered.deliveryId
    ])) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      deliveryReport: {
        schemaVersion: number;
        agentReport: { humanActions: Array<{ action: string; source: string }> };
        presentation: {
          status: string;
          markdown: string;
          humanActions: Array<{ action: string }>;
          tradeoffsMade: Array<{ decision: string; alternativesConsidered: string[] }>;
        };
      };
    };

    assert.equal(payload.deliveryReport.schemaVersion, 1);
    assert.deepEqual(payload.deliveryReport.agentReport.humanActions, [
      {
        id: 'human-action-1',
        action: 'Add the production Gemini credential before enabling composition.',
        reason: 'Phase 3 composition needs an operator-managed provider credential.',
        category: 'environment',
        blocking: false,
        source: 'agent'
      }
    ]);
    assert.equal(payload.deliveryReport.presentation.status, 'pending');
    assert.equal(
      payload.deliveryReport.presentation.markdown,
      'Implemented the durable delivery evidence pipeline.'
    );
    assert.deepEqual(payload.deliveryReport.presentation.humanActions, [
      payload.deliveryReport.agentReport.humanActions[0]
    ]);
    assert.deepEqual(payload.deliveryReport.presentation.tradeoffsMade[0]?.alternativesConsidered, [
      'Block delivery on Gemini',
      'Require agents to compose display Markdown'
    ]);

    const composeJob = (await ctx.db.get(
      `SELECT type, status, payload_json FROM worker_jobs
         WHERE type = 'overlord.delivery.compose.v1'
         ORDER BY created_at DESC LIMIT 1`
    )) as { type: string; status: string; payload_json: string } | undefined;
    assert.ok(composeJob);
    assert.equal(composeJob.status, 'queued');
    assert.equal(JSON.parse(composeJob.payload_json).deliveryId, delivered.deliveryId);

    await db.close();
  });

  it('rejects malformed or oversized delivery evidence without completing the objective', async () => {
    const { db, ctx } = await setup();
    const { mission, objectiveId } = await submittedMission(ctx, 'Invalid Delivery Evidence');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    await assert.rejects(
      () =>
        deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'This should not deliver.',
          payloadJson: { deliveryReport: { schemaVersion: 2 } }
        }),
      /Invalid deliveryReport/
    );
    await assert.rejects(
      () =>
        deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'This should not deliver either.',
          payloadJson: {
            deliveryReport: {
              agentReport: {
                knownRisks: Array.from({ length: 13 }, (_, index) => `Risk ${index + 1}`)
              }
            }
          }
        }),
      /Invalid deliveryReport/
    );

    const objective = (await ctx.db.get(`SELECT state FROM objectives WHERE id = ?`, [
      objectiveId
    ])) as {
      state: string;
    };
    assert.equal(objective.state, 'executing');
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
    const placeholder = attached.futureObjectives.find(objective => objective.state === 'draft');
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
            claude: { launchDefaults: { preCommand: 'nvm use 20', flags: [{ name: '--verbose' }] } }
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
      flags?: Array<{ name: string; value?: string | null }>;
    };
    assert.equal(flags.preCommand, 'nvm use 20');
    assert.deepEqual(flags.flags, [{ name: '--verbose', value: null }]);

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

  it('reconciles a stale changed_files row to resolved once observedDirtyPaths no longer includes it', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Reconcile Stale');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    // First delivery: an over-attributed file (e.g. recorded while an edit hook
    // was inert) gets a real rationale so delivery succeeds.
    await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: attached.sessionKey,
      summary: 'First delivery',
      changedFiles: [{ filePath: 'src/leftover.ts', vcsStatus: 'M' }],
      changeRationales: [
        {
          file_path: 'src/leftover.ts',
          label: 'Leftover',
          summary: 'Touched leftover.',
          why: 'Needed then.',
          impact: 'Ships.'
        }
      ]
    });

    // Follow-up: the file is no longer dirty. observedDirtyPaths reflects the
    // current (clean) worktree, so the stale row should be reconciled to
    // 'resolved' and never demand a rationale again.
    const resumed = await resumeFollowUp({ ctx, missionId: mission.displayId });
    const result = await deliverSession({
      ctx,
      missionId: mission.displayId,
      sessionKey: resumed.sessionKey,
      summary: 'Follow-up delivery with a clean tree',
      observedDirtyPaths: []
    });
    assert.ok(result.deliveryId);

    const row = (await ctx.db.get(
      `SELECT current_diff_state FROM changed_files WHERE file_path = ? AND deleted_at IS NULL`,
      ['src/leftover.ts']
    )) as { current_diff_state: string } | undefined;
    assert.equal(row?.current_diff_state, 'resolved');

    const files = await listChangedFilesForReview({
      ctx,
      missionId: mission.displayId,
      includeCurrent: false
    });
    assert.equal(files.find(file => file.filePath === 'src/leftover.ts')?.coverage, 'resolved');

    await db.close();
  });

  it('structures a missing_rationale error with per-path classification and a ready-to-use skip', async () => {
    const { db, ctx } = await setup();
    const { mission } = await submittedMission(ctx, 'Structured Error');
    const attached = await attachSession({ ctx, missionId: mission.displayId });

    await assert.rejects(
      async () =>
        await deliverSession({
          ctx,
          missionId: mission.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Deliver without rationale',
          changedFiles: [
            { filePath: 'src/mine.ts', vcsStatus: 'M', attribution: 'mine' },
            {
              filePath: 'src/theirs.ts',
              vcsStatus: 'M',
              attribution: 'claimed',
              claimedByMissionIds: ['coo:999']
            },
            { filePath: 'src/ambiguous.ts', vcsStatus: 'M', attribution: 'unclaimed' }
          ]
        }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        assert.equal(error.code, 'missing_rationale');
        const details = error.details as {
          missingRationales: Array<{
            filePath: string;
            classification: string;
            suggestedSkip: { filePath: string; reason: string } | null;
          }>;
        };
        const byPath = new Map(details.missingRationales.map(entry => [entry.filePath, entry]));
        assert.equal(byPath.get('src/mine.ts')?.classification, 'mine');
        assert.equal(byPath.get('src/mine.ts')?.suggestedSkip, null);
        assert.equal(byPath.get('src/theirs.ts')?.classification, 'claimed');
        assert.match(byPath.get('src/theirs.ts')?.suggestedSkip?.reason ?? '', /coo:999/);
        assert.equal(byPath.get('src/ambiguous.ts')?.classification, 'unclaimed');
        assert.ok(byPath.get('src/ambiguous.ts')?.suggestedSkip);
        return true;
      }
    );

    await db.close();
  });
});
