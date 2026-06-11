import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateDatabase, openInMemoryDatabase } from '../../dist/database/connection.js';
import { createServiceContext } from '../../dist/service/context.js';
import { createProject } from '../../dist/service/projects.js';
import { createTicketWithObjectives, listTickets } from '../../dist/service/tickets.js';
test('withAdapter-style harness creates seeded workspace', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'cli' });
    assert.equal(ctx.workspace.id, 'local-workspace');
    db.close();
});
test('create ticket with multiple objectives from service layer', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'cli' });
    const project = createProject({ ctx, name: 'Multi Objective Project' });
    const result = createTicketWithObjectives({
        ctx,
        projectId: project.id,
        objectives: [{ objective: 'Step one' }, { objective: 'Step two' }]
    });
    assert.equal(result.objectives.length, 2);
    assert.equal(result.objectives[0]?.state, 'draft');
    assert.equal(result.objectives[1]?.position, 1);
    const listed = listTickets({ ctx, projectId: project.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.objectiveCount, 2);
    db.close();
});
export async function withMemoryDb(fn) {
    const db = openInMemoryDatabase();
    try {
        return await fn(db);
    }
    finally {
        db.close();
    }
}
export function applyMigrations(db) {
    migrateDatabase(db);
}
//# sourceMappingURL=harness.js.map