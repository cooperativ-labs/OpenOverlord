import { openInMemoryDatabase, SEED_USER_ID } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import {
  agentInstructionsFromProfileMetadata,
  loadAgentInstructionsForWorkspaceUser,
  mergeProfileMetadataJson
} from './profiles.js';
import { createProject } from './projects.js';
import { attachSession } from './protocol.js';
import { createTicketWithObjectives } from './tickets.js';

describe('profile metadata helpers', () => {
  it('round-trips agent instructions through metadata_json', () => {
    const merged = mergeProfileMetadataJson({
      metadataJson: '{"avatarUrl":"https://example.com/a.png"}',
      agentInstructions: 'Always run tests.'
    });
    assert.equal(agentInstructionsFromProfileMetadata(merged), 'Always run tests.');
  });
});

describe('promptContext custom agent instructions', () => {
  it('includes saved user instructions in attach promptContext', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'protocol' });

    db.prepare(
      `UPDATE profiles SET metadata_json = ? WHERE id = ?`
    ).run(
      mergeProfileMetadataJson({
        metadataJson: '{}',
        agentInstructions: 'Prefer yarn over npm.'
      }),
      SEED_USER_ID
    );

    assert.equal(
      loadAgentInstructionsForWorkspaceUser({
        db,
        workspaceUserId: ctx.actorWorkspaceUserId
      }),
      'Prefer yarn over npm.'
    );

    const project = createProject({ ctx, name: 'Custom Instructions' });
    const { ticket, objectives } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Verify custom instructions' }]
    });
    ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

    const attached = attachSession({ ctx, ticketId: ticket.id });
    assert.match(attached.promptContext, /## Additional Instructions/);
    assert.match(attached.promptContext, /Prefer yarn over npm\./);

    db.close();
  });
});
