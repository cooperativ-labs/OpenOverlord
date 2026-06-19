import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { createTicketWithObjectives, moveTicketToReview } from './tickets.js';

function setup() {
  const db = openInMemoryDatabase();
  const ctx = createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

function boardPosition(db: ReturnType<typeof openInMemoryDatabase>, ticketId: string): number {
  const row = db.prepare(`SELECT board_position FROM tickets WHERE id = ?`).get(ticketId) as {
    board_position: number;
  };
  return row.board_position;
}

describe('moveTicketToReview board placement', () => {
  it('places the ticket above any tickets already in the review column', () => {
    const { db, ctx } = setup();
    const project = createProject({ ctx, name: 'Review Ordering' });

    const { ticket: firstTicket } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'First into review' }]
    });
    const { ticket: secondTicket } = createTicketWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Second into review' }]
    });

    moveTicketToReview({ ctx, ticketId: firstTicket.id });
    const firstPosition = boardPosition(db, firstTicket.id);

    moveTicketToReview({ ctx, ticketId: secondTicket.id });
    const secondPosition = boardPosition(db, secondTicket.id);

    assert.ok(
      secondPosition < firstPosition,
      'a ticket auto-advanced to review later should sort above one already in the column'
    );
  });
});
