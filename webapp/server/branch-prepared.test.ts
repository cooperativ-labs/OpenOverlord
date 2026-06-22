import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Guards per-ticket branch recording end to end. The runner persists the prepared
// branch in `tickets.active_branch` and records a human-readable audit event under
// the allowed `update` type — using a `branch_prepared` event type instead would
// violate the closed `ticket_events.type` CHECK and fail every worktree launch.
describe('branch preparation recording', () => {
  it('persists the active branch and surfaces it on the ticket detail DTO', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-branch-prepared-'));
    process.env.OVERLORD_SQLITE_PATH = path.join(dir, 'Overlord.sqlite');

    const { createProject, createTicket, getTicketDetail, listTicketEvents } =
      await import('./repository.ts');
    const { recordBranchPrepared } = await import('./runner.ts');

    const project = createProject({ name: 'Branch Prepared Test' });
    const ticket = createTicket({
      projectId: project.id,
      firstObjective: 'Prepare a branch'
    });

    // Before any launch, the DTO predicts the canonical branch with a pending status.
    assert.equal(getTicketDetail(ticket.id).branch?.status, 'pending');

    assert.doesNotThrow(() =>
      recordBranchPrepared({
        ticketId: ticket.displayId,
        payload: {
          branchName: 'overlord/prepare-a-branch-1',
          baseBranch: 'main',
          worktreePath: '/tmp/.ovld/worktrees/branch-prepared/overlord-prepare-a-branch-1',
          action: 'create',
          cycle: 1
        }
      })
    );

    const branch = getTicketDetail(ticket.id).branch;
    assert.equal(branch?.name, 'overlord/prepare-a-branch-1');
    assert.equal(branch?.baseBranch, 'main');
    // No real git checkout backs the test project, so the branch reads as active.
    assert.equal(branch?.status, 'active');

    // The audit entry is recorded under an allowed event type, not `branch_prepared`.
    const events = listTicketEvents(ticket.displayId);
    assert.ok(events.some(event => event.summary.includes('Prepared branch')));
    assert.ok(!events.some(event => event.type === 'branch_prepared'));
  });
});
