import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('ticket reference resolution', () => {
  it('resolves tickets by UUID or display_id for detail and child reads', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-ticket-ref-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createTicket, getTicketDetail, listTicketEvents } =
      await import('./repository.ts');

    const project = createProject({ name: 'Ticket Ref Test' });
    const created = createTicket({
      projectId: project.id,
      firstObjective: 'Resolve by display id'
    });

    assert.equal(getTicketDetail(created.id).id, created.id);
    assert.equal(getTicketDetail(created.displayId).id, created.id);
    assert.equal(getTicketDetail(created.displayId).displayId, created.displayId);
    assert.doesNotThrow(() => listTicketEvents(created.displayId));
  });

  it('assigns new tickets to the creator by default, unless explicitly unassigned', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-ticket-assignee-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createTicket } = await import('./repository.ts');
    const { ACTOR_WORKSPACE_USER_ID } = await import('./db.ts');

    const project = createProject({ name: 'Ticket Assignee Test' });
    const created = createTicket({
      projectId: project.id,
      firstObjective: 'Default assignee to creator'
    });
    assert.equal(created.assignedWorkspaceUserId, ACTOR_WORKSPACE_USER_ID);

    const explicitlyUnassigned = createTicket({
      projectId: project.id,
      firstObjective: 'Allow explicit unassign on create',
      assignedWorkspaceUserId: null
    });
    assert.equal(explicitlyUnassigned.assignedWorkspaceUserId, null);
  });
});
