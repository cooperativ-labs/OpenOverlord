import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { protocolCreate, protocolPrompt } from './protocol.js';

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
