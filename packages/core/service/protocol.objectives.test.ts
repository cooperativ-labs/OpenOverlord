import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createMissionWithObjectives, insertObjective } from './missions.js';
import { createProject } from './projects.js';
import { attachSession, protocolCreate, protocolPrompt } from './protocol.js';

describe('protocol objective creation', () => {
  it('creates ordered objectives from an array payload', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Protocol Objectives' });

    const result = await protocolCreate({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'First protocol objective' },
        { objective: 'Second protocol objective' }
      ]
    });

    assert.equal(result.objectives.length, 2);
    assert.deepEqual(
      result.objectives.map(objective => objective.state),
      ['draft', 'future']
    );

    await db.close();
  });

  it('allows blank inline-authored draft and future objective slots', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Blank Objective Slots' });
    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    await ctx.db.run(`UPDATE objectives SET state = 'complete' WHERE mission_id = ?`, [mission.id]);
    const draft = await insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: '',
      state: 'draft'
    });

    assert.equal(draft.state, 'draft');
    assert.equal(draft.objective, '');
    assert.equal(draft.title, 'New objective');

    const future = await insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: '',
      state: 'draft'
    });

    assert.equal(future.state, 'future');
    assert.equal(future.objective, '');
    assert.equal(future.title, 'New objective');

    await db.close();
  });

  it('rejects blank submitted objectives', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Submitted Objective Validation' });
    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    await assert.rejects(
      async () =>
        await insertObjective({
          ctx,
          missionId: mission.id,
          instructionText: '',
          state: 'submitted'
        })
    );

    await db.close();
  });

  it('prompts with multiple objectives and attaches to the first one', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Protocol Prompt Objectives' });

    const result = await protocolPrompt({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'First prompt objective' },
        { objective: 'Second prompt objective' }
      ],
      agentIdentifier: 'codex'
    });

    assert.equal(result.objectives.length, 2);
    assert.equal(result.objective.objective, 'First prompt objective');
    assert.equal(result.objective.state, 'executing');
    assert.equal(result.objectives[1]?.state, 'draft');

    await db.close();
  });

  it('creates a blank draft slot when attach consumes the only next-up objective', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Attach Refill' });
    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Only objective' }]
    });

    await ctx.db.run(`UPDATE objectives SET assigned_agent = 'claude' WHERE id = ?`, [
      objectives[0]?.id
    ]);

    const attached = await attachSession({
      ctx,
      missionId: mission.displayId,
      agentIdentifier: 'codex'
    });

    assert.equal(attached.objective.state, 'executing');
    assert.equal(attached.objectives.length, 2);

    const draft = attached.objectives.find(objective => objective.state === 'draft');
    assert.ok(draft);
    assert.equal(draft.objective, '');
    assert.equal(draft.title, 'New objective');

    const draftRow = (await ctx.db.get(`SELECT assigned_agent FROM objectives WHERE id = ?`, [
      draft.id
    ])) as { assigned_agent: string | null };
    assert.equal(draftRow.assigned_agent, 'claude');

    await db.close();
  });

  it('promotes the earliest future objective when attach consumes the next-up objective', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Attach Future Refill' });
    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'Run current objective' },
        { objective: 'Use existing future objective' }
      ]
    });

    const attached = await attachSession({
      ctx,
      missionId: mission.displayId,
      agentIdentifier: 'codex'
    });

    assert.equal(attached.objective.state, 'executing');
    assert.equal(attached.objectives.length, 2);
    assert.deepEqual(
      attached.objectives.map(objective => objective.state),
      ['executing', 'draft']
    );
    assert.equal(attached.objectives[1]?.id, objectives[1]?.id);
    assert.equal(attached.objectives[1]?.objective, 'Use existing future objective');

    await db.close();
  });

  it('promotes a future objective over a blank draft placeholder when attach begins execution', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Attach Future Before Placeholder' });
    const { mission, objectives } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'Run current objective' },
        { objective: 'Use queued future objective' }
      ]
    });

    await ctx.db.run(`UPDATE objectives SET state = 'launching' WHERE id = ?`, [objectives[0]?.id]);
    const placeholder = await insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: '',
      state: 'draft'
    });

    const attached = await attachSession({
      ctx,
      missionId: mission.displayId,
      agentIdentifier: 'codex'
    });

    assert.equal(attached.objective.state, 'executing');
    assert.deepEqual(
      attached.objectives.map(objective => objective.state),
      ['executing', 'draft']
    );
    assert.equal(attached.objectives[1]?.id, objectives[1]?.id);
    assert.equal(attached.objectives[1]?.objective, 'Use queued future objective');

    const placeholderRow = (await ctx.db.get(`SELECT deleted_at FROM objectives WHERE id = ?`, [
      placeholder.id
    ])) as { deleted_at: string | null };
    assert.ok(placeholderRow.deleted_at);

    await db.close();
  });
});
