import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext, type ServiceContext } from './context.js';
import { createProject } from './projects.js';
import { createTicketWithObjectives, searchTickets } from './tickets.js';
import { newId, nowIso } from './util.js';

function setup(): { ctx: ServiceContext; projectId: string } {
  const db = openInMemoryDatabase();
  const ctx = createServiceContext({ db, source: 'cli' });
  const project = createProject({ ctx, name: 'Search Project' });
  return { ctx, projectId: project.id };
}

function recordEvent(
  ctx: ServiceContext,
  ticketId: string,
  projectId: string,
  summary: string
): void {
  ctx.db
    .prepare(
      `INSERT INTO ticket_events (
         id, workspace_id, project_id, ticket_id, type, summary, source, created_at
       ) VALUES (?, ?, ?, ?, 'update', ?, 'cli', ?)`
    )
    .run(newId(), ctx.workspace.id, projectId, ticketId, summary, nowIso());
}

describe('searchTickets full-text ranking', () => {
  it('matches on ticket title, objective body, and event summary', () => {
    const { ctx, projectId } = setup();

    const titled = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Zylophonics dashboard rewrite',
      objectives: [{ objective: 'Plain unrelated work' }]
    });
    const viaObjective = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Generic ticket two',
      objectives: [{ objective: 'Investigate the quarkbarrel ingestion pipeline' }]
    });
    const viaEvent = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Generic ticket three',
      objectives: [{ objective: 'Some baseline task' }]
    });
    recordEvent(
      ctx,
      viaEvent.ticket.id,
      projectId,
      'Agent noted a flux capacitor regression in logs'
    );

    assert.deepEqual(
      searchTickets({ ctx, query: 'zylophonics' }).map(t => t.id),
      [titled.ticket.id]
    );
    assert.deepEqual(
      searchTickets({ ctx, query: 'quarkbarrel' }).map(t => t.id),
      [viaObjective.ticket.id]
    );
    assert.deepEqual(
      searchTickets({ ctx, query: 'capacitor' }).map(t => t.id),
      [viaEvent.ticket.id]
    );

    ctx.db.close();
  });

  it('supports prefix matching on partial words', () => {
    const { ctx, projectId } = setup();
    const ticket = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Implement efficient ticket search',
      objectives: [{ objective: 'baseline' }]
    });

    assert.deepEqual(
      searchTickets({ ctx, query: 'effic' }).map(t => t.id),
      [ticket.ticket.id]
    );
    ctx.db.close();
  });

  it('ranks a title match above an event-only match for the same term', () => {
    const { ctx, projectId } = setup();
    const inTitle = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Moonbeam telemetry overhaul',
      objectives: [{ objective: 'baseline one' }]
    });
    const inEvent = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Logging cleanup',
      objectives: [{ objective: 'baseline two' }]
    });
    recordEvent(ctx, inEvent.ticket.id, projectId, 'Discussed moonbeam edge cases with the team');

    const ranked = searchTickets({ ctx, query: 'moonbeam' }).map(t => t.id);
    assert.deepEqual(ranked, [inTitle.ticket.id, inEvent.ticket.id]);
    ctx.db.close();
  });

  it('drops soft-deleted tickets from results', () => {
    const { ctx, projectId } = setup();
    const ticket = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Krypton storage migration',
      objectives: [{ objective: 'baseline' }]
    });

    assert.equal(searchTickets({ ctx, query: 'krypton' }).length, 1);

    ctx.db
      .prepare(`UPDATE tickets SET deleted_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(nowIso(), ticket.ticket.id);

    assert.equal(searchTickets({ ctx, query: 'krypton' }).length, 0);
    // Soft-deleting the ticket removes all of its indexed documents.
    const remaining = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM search_documents WHERE ticket_id = ?`)
      .get(ticket.ticket.id) as { c: number };
    assert.equal(remaining.c, 0);
    ctx.db.close();
  });

  it('falls back to a recency listing when the query has no usable terms', () => {
    const { ctx, projectId } = setup();
    const older = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Older ticket',
      objectives: [{ objective: 'baseline' }]
    });
    const newer = createTicketWithObjectives({
      ctx,
      projectId,
      title: 'Newer ticket',
      objectives: [{ objective: 'baseline' }]
    });
    // Touch the newer ticket so it sorts first by updated_at.
    ctx.db
      .prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`)
      .run('2999-01-01T00:00:00.000Z', newer.ticket.id);

    const results = searchTickets({ ctx, query: '   ' });
    assert.ok(results.length >= 2);
    assert.equal(results[0]?.id, newer.ticket.id);
    assert.ok(results.some(t => t.id === older.ticket.id));
    ctx.db.close();
  });
});
