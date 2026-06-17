import { migrateDatabase } from '@overlord/database';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { listChangedFilesForReview, listRationalesForReview } from '../dist/src/service/changes.js';
import { createServiceContext } from '../dist/src/service/context.js';
import { newId } from '../dist/src/service/util.js';
import {
  claimNextExecutionRequest,
  clearExecutionRequests,
  createExecutionRequest,
  listExecutionRequests,
  markExecutionLaunched,
  markExecutionLaunching
} from '../dist/src/service/execution-requests.js';
import { addProjectResource, createProject } from '../dist/src/service/projects.js';
import { attachSession, deliverSession, updateSession } from '../dist/src/service/protocol.js';
import { createTicketWithObjectives } from '../dist/src/service/tickets.js';

function createContext() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return { db, ctx: createServiceContext({ db, source: 'cli' }) };
}

test('execution request queue rejects when no primary resource is linked', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'No Primary Resource Test' });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue without a primary resource' }]
  });

  assert.throws(
    () =>
      createExecutionRequest({
        ctx,
        ticketId: ticket.displayId,
        objectiveId: objectives[0]?.id,
        requestedAgent: 'codex',
        requestedSource: 'cli'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('No primary resource is linked') &&
      'code' in error &&
      (error as { code: string }).code === 'primary_resource_not_connected'
  );

  db.close();
});

test('execution request queue rejects when the primary resource path is missing', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Missing Primary Path Test' });
  addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: path.join(process.cwd(), '.overlord-missing-primary-test'),
    isPrimary: true
  });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Should not queue with a missing primary path' }]
  });

  assert.throws(
    () =>
      createExecutionRequest({
        ctx,
        ticketId: ticket.displayId,
        objectiveId: objectives[0]?.id,
        requestedAgent: 'codex',
        requestedSource: 'cli'
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('Primary working directory is missing') &&
      'code' in error &&
      (error as { code: string }).code === 'primary_resource_not_connected'
  );

  db.close();
});

test('claiming a queued request fails when the primary resource is missing', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Claim Missing Primary Test' });
  const resourcePath = path.join(process.cwd(), '.overlord-missing-primary-claim-test');
  addProjectResource({
    ctx,
    projectId: project.id,
    directoryPath: resourcePath,
    isPrimary: true
  });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Queued before the primary path disappeared' }]
  });

  const requestId = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO execution_requests
       (id, workspace_id, project_id, ticket_id, objective_id, requested_agent,
        launch_mode, launch_flags_json, target_kind, requested_source, status,
        created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, 'codex', 'run', '{}', 'local', 'webapp', 'queued', ?, ?, 1)`
  ).run(requestId, ctx.workspace.id, project.id, ticket.id, objectives[0]?.id, now, now);

  assert.equal(claimNextExecutionRequest({ ctx }), null);

  const failed = db
    .prepare(`SELECT status, last_error FROM execution_requests WHERE id = ?`)
    .get(requestId) as { status: string; last_error: string };
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /Primary working directory is missing/);

  db.close();
});

test('execution request queue can create, claim, launch, and clear active requests', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Runner Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Run the next objective' }]
  });

  const request = createExecutionRequest({
    ctx,
    ticketId: ticket.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(request.status, 'queued');

  const duplicate = createExecutionRequest({
    ctx,
    ticketId: ticket.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli',
    idempotencyKey: 'manual:test'
  });
  assert.equal(duplicate.id, request.id);

  const claimed = claimNextExecutionRequest({ ctx });
  assert.ok(claimed);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.workingDirectory, process.cwd());

  const launching = markExecutionLaunching({ ctx, requestId: claimed.id });
  assert.equal(launching.status, 'launching');
  const launched = markExecutionLaunched({ ctx, requestId: claimed.id });
  assert.equal(launched.status, 'launched');

  const active = listExecutionRequests({ ctx });
  assert.equal(active.length, 0);

  const second = createExecutionRequest({
    ctx,
    ticketId: ticket.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(second.status, 'queued');
  assert.equal(clearExecutionRequests({ ctx, objectiveId: objectives[0]?.id }).cleared, 1);

  db.close();
});

test('runner does not claim a queued request for a soft-deleted objective', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Deleted Objective Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Objective to be removed' }]
  });

  const request = createExecutionRequest({
    ctx,
    ticketId: ticket.displayId,
    objectiveId: objectives[0]?.id,
    requestedAgent: 'codex',
    requestedSource: 'cli'
  });
  assert.equal(request.status, 'queued');

  // Mirror a UI disconnect/delete that soft-deletes the objective. The runner
  // must skip the orphaned request rather than launch retired work.
  ctx.db
    .prepare(`UPDATE objectives SET deleted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), objectives[0]?.id);

  assert.equal(claimNextExecutionRequest({ ctx }), null);

  db.close();
});

test('delivery auto-advance queues next objective when enabled', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Auto Advance Test' });
  addProjectResource({ ctx, projectId: project.id, directoryPath: process.cwd(), isPrimary: true });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective', autoAdvance: true }
    ]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const attached = attachSession({ ctx, ticketId: ticket.displayId });
  deliverSession({
    ctx,
    ticketId: ticket.displayId,
    sessionKey: attached.sessionKey,
    summary: 'First objective complete'
  });

  const requests = listExecutionRequests({ ctx });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.objectiveId, objectives[1]?.id);
  assert.equal(requests[0]?.requestedSource, 'auto_advance');

  db.close();
});

test('change review reports missing and covered rationales', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Change Review Test' });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Track changes' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);
  const attached = attachSession({ ctx, ticketId: ticket.displayId });

  updateSession({
    ctx,
    ticketId: ticket.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Changed files',
    changedFiles: [{ filePath: 'src/example.ts', vcsStatus: 'M' }]
  });
  assert.equal(
    listChangedFilesForReview({ ctx, ticketId: ticket.displayId, includeCurrent: false })[0]
      ?.coverage,
    'missing_rationale'
  );

  deliverSession({
    ctx,
    ticketId: ticket.displayId,
    sessionKey: attached.sessionKey,
    summary: 'Delivered tracked change',
    changeRationales: [
      {
        file_path: 'src/example.ts',
        label: 'Example change',
        summary: 'Updated the example.',
        why: 'Required for the test.',
        impact: 'Review shows covered rationale.'
      }
    ]
  });

  const files = listChangedFilesForReview({
    ctx,
    ticketId: ticket.displayId,
    includeCurrent: false
  });
  assert.equal(files[0]?.coverage, 'covered');
  assert.equal(listRationalesForReview({ ctx, ticketId: ticket.displayId }).length, 1);

  db.close();
});
