import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listChangedFilesForReview } from './changes.js';
import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { attachSession, deliverSession, updateSession } from './protocol.js';
import { createTicketWithObjectives } from './tickets.js';
import { nowIso } from './util.js';

function setup() {
  const db = openInMemoryDatabase();
  const ctx = createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

function submittedTicket(ctx: ReturnType<typeof createServiceContext>, name: string) {
  const project = createProject({ ctx, name });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: `Work for ${name}` }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);
  return { project, ticket, objectiveId: objectives[0]?.id as string };
}

describe('deliverSession mechanical change capture', () => {
  it('records run-supplied changed files and enforces rationale coverage', () => {
    const { db, ctx } = setup();
    const { ticket } = submittedTicket(ctx, 'Deliver Capture');
    const attached = attachSession({ ctx, ticketId: ticket.displayId });

    // The CLI injects the VCS delta as changedFiles at deliver; a changed file
    // without a rationale must block delivery.
    assert.throws(
      () =>
        deliverSession({
          ctx,
          ticketId: ticket.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Deliver without rationale',
          changedFiles: [{ filePath: 'src/feature.ts', vcsStatus: 'M' }]
        }),
      /Missing change rationale for src\/feature\.ts/
    );

    // With the rationale, delivery succeeds and the file is recorded and covered.
    deliverSession({
      ctx,
      ticketId: ticket.displayId,
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

    const files = listChangedFilesForReview({
      ctx,
      ticketId: ticket.displayId,
      includeCurrent: false
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filePath, 'src/feature.ts');
    assert.equal(files[0]?.coverage, 'covered');

    db.close();
  });

  it('accepts the camelCase filePath alias for a rationale', () => {
    const { db, ctx } = setup();
    const { ticket } = submittedTicket(ctx, 'Rationale Alias');
    const attached = attachSession({ ctx, ticketId: ticket.displayId });

    // An agent that generalizes the changed-files `filePath` casing to a
    // rationale must no longer be rejected; the alias normalizes to file_path
    // and satisfies coverage for the same path.
    deliverSession({
      ctx,
      ticketId: ticket.displayId,
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

    const files = listChangedFilesForReview({
      ctx,
      ticketId: ticket.displayId,
      includeCurrent: false
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filePath, 'src/alias.ts');
    assert.equal(files[0]?.coverage, 'covered');

    db.close();
  });

  it('skips rationale coverage when the run declares no file changes', () => {
    const { db, ctx } = setup();
    const { ticket, objectiveId } = submittedTicket(ctx, 'No File Changes');
    const attached = attachSession({ ctx, ticketId: ticket.displayId });

    // A changed file was observed earlier, but the explicit no-file-changes
    // declaration must skip coverage so a genuine no-op run can deliver.
    updateSession({
      ctx,
      ticketId: ticket.displayId,
      sessionKey: attached.sessionKey,
      summary: 'Observed a leftover edit',
      changedFiles: [{ filePath: 'src/leftover.ts', vcsStatus: 'M' }]
    });

    const result = deliverSession({
      ctx,
      ticketId: ticket.displayId,
      sessionKey: attached.sessionKey,
      summary: 'No files changed in this run.',
      noFileChanges: true
    });
    assert.ok(result.deliveryId);

    const objective = ctx.db
      .prepare(`SELECT state FROM objectives WHERE id = ?`)
      .get(objectiveId) as { state: string };
    assert.equal(objective.state, 'complete');

    db.close();
  });

  it('enforces coverage objective-scoped across no-session records', () => {
    const { db, ctx } = setup();
    const { project, ticket, objectiveId } = submittedTicket(ctx, 'Objective Scope');
    const attached = attachSession({ ctx, ticketId: ticket.displayId });

    // A changed file recorded with no session (record-work style) for this
    // objective. Under the old session-scoped check a different session's
    // delivery would miss it; objective-scoped coverage must still require it.
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO changed_files
           (id, workspace_id, project_id, ticket_id, objective_id, session_id, file_path, vcs_status,
            current_diff_state, first_observed_at, last_observed_at, observed_metadata_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'M', 'present', ?, ?, '{}', ?, ?, 1)`
      )
      .run(
        'cf-scope-1',
        ctx.workspace.id,
        project.id,
        ticket.id,
        objectiveId,
        'src/shared.ts',
        now,
        now,
        now,
        now
      );

    assert.throws(
      () =>
        deliverSession({
          ctx,
          ticketId: ticket.displayId,
          sessionKey: attached.sessionKey,
          summary: 'Deliver objective'
        }),
      /Missing change rationale for src\/shared\.ts/
    );

    db.close();
  });
});
