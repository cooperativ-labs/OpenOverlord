import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { protocolCreate, protocolPrompt } from './protocol.js';
import { createTicketWithObjectives, insertObjective } from './tickets.js';

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
    const { ticket } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    ctx.db.prepare(`UPDATE objectives SET state = 'complete' WHERE ticket_id = ?`).run(ticket.id);
    const draft = insertObjective({
      ctx,
      ticketId: ticket.id,
      instructionText: '',
      state: 'draft'
    });

    assert.equal(draft.state, 'draft');
    assert.equal(draft.objective, '');
    assert.equal(draft.title, 'New objective');

    const future = insertObjective({
      ctx,
      ticketId: ticket.id,
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
    const { ticket } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Existing draft objective' }]
    });

    assert.throws(() =>
      insertObjective({
        ctx,
        ticketId: ticket.id,
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
});
