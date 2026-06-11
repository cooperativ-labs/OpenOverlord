import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateDatabase } from '../dist/src/database/connection.js';
import { createServiceContext } from '../dist/src/service/context.js';
import { createProject } from '../dist/src/service/projects.js';
import { addObjectivesToTicket, createTicketWithObjectives } from '../dist/src/service/tickets.js';

function createContext() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return { db, ctx: createServiceContext({ db, source: 'cli' }) };
}

test('ticket creation creates one draft objective and future objectives for the rest', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Objective Creation Test' });

  const { objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective' },
      { objective: 'Third objective' }
    ]
  });

  assert.deepEqual(
    objectives.map(objective => objective.state),
    ['draft', 'future', 'future']
  );

  db.close();
});

test('adding objectives to a ticket with a draft creates future objectives', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Add Objectives Test' });
  const { ticket } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing draft' }]
  });

  const added = addObjectivesToTicket({
    ctx,
    ticketId: ticket.id,
    objectives: [{ objective: 'Additional objective' }, { objective: 'Another objective' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['future', 'future']
  );

  db.close();
});

test('adding objectives to a ticket without a draft creates exactly one draft', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Refill Draft Test' });
  const { ticket, objectives } = createTicketWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing objective' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const added = addObjectivesToTicket({
    ctx,
    ticketId: ticket.id,
    objectives: [{ objective: 'New next-up' }, { objective: 'Future follow-up' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['draft', 'future']
  );

  db.close();
});
