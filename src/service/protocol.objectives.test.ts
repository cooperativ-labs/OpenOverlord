import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createMissionWithObjectives, insertObjective } from './missions.js';
import { createProject } from './projects.js';
import { attachSession, protocolCreate, protocolPrompt } from './protocol.js';

describe('protocol objective creation', () => {
  it('creates ordered objectives from an array payload', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Protocol Objectives' });

    const result = protocolCreate({
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

    db.close();
  });

  it('allows blank inline-authored draft and future objective slots', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Blank Objective Slots' });
    const { mission } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    ctx.db.prepare(`UPDATE objectives SET state = 'complete' WHERE mission_id = ?`).run(mission.id);
    const draft = insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: '',
      state: 'draft'
    });

    assert.equal(draft.state, 'draft');
    assert.equal(draft.objective, '');
    assert.equal(draft.title, 'New objective');

    const future = insertObjective({
      ctx,
      missionId: mission.id,
      instructionText: '',
      state: 'draft'
    });

    assert.equal(future.state, 'future');
    assert.equal(future.objective, '');
    assert.equal(future.title, 'New objective');

    db.close();
  });

  it('rejects blank submitted objectives', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Submitted Objective Validation' });
    const { mission } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    assert.throws(() =>
      insertObjective({
        ctx,
        missionId: mission.id,
        instructionText: '',
        state: 'submitted'
      })
    );

    db.close();
  });

  it('prompts with multiple objectives and attaches to the first one', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Protocol Prompt Objectives' });

    const result = protocolPrompt({
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

    db.close();
  });

  it('creates a blank draft slot when attach consumes the only next-up objective', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Attach Refill' });
    const { mission, objectives } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Only objective' }]
    });

    ctx.db
      .prepare(`UPDATE objectives SET assigned_agent = 'claude' WHERE id = ?`)
      .run(objectives[0]?.id);

    const attached = attachSession({
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

    const draftRow = ctx.db
      .prepare(`SELECT assigned_agent FROM objectives WHERE id = ?`)
      .get(draft.id) as { assigned_agent: string | null };
    assert.equal(draftRow.assigned_agent, 'claude');

    db.close();
  });

  it('promotes the earliest future objective when attach consumes the next-up objective', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });
    const project = createProject({ ctx, name: 'Attach Future Refill' });
    const { mission, objectives } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [
        { objective: 'Run current objective' },
        { objective: 'Use existing future objective' }
      ]
    });

    const attached = attachSession({
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

    db.close();
  });
});
