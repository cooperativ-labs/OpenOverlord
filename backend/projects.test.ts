import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-projects-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
await bootstrapIntegrationTestDb({ sqlitePath: path.join(tempDir, 'webapp.sqlite') });

const { db } = await import('./db.ts');
const { createProject, listProjects, reorderProjects } = await import('./repository.ts');
const { ApiError } = await import('./errors.ts');

test('reordering projects swaps positions without violating the unique workspace constraint', async () => {
  const first = await createProject({ name: 'Project One' });
  const second = await createProject({ name: 'Project Two' });
  const third = await createProject({ name: 'Project Three' });

  const reordered = await reorderProjects({
    orderedProjectIds: [second.id, first.id, third.id]
  });

  assert.deepEqual(
    reordered.map(project => ({ id: project.id, position: project.position })),
    [
      { id: second.id, position: 1 },
      { id: first.id, position: 2 },
      { id: third.id, position: 3 }
    ]
  );

  const persisted = await listProjects();
  assert.deepEqual(
    persisted.map(project => ({ id: project.id, position: project.position })),
    [
      { id: second.id, position: 1 },
      { id: first.id, position: 2 },
      { id: third.id, position: 3 }
    ]
  );

  const rows = db
    .prepare(
      `SELECT id, position
         FROM projects
        WHERE id IN (?, ?, ?)
        ORDER BY position ASC`
    )
    .all(first.id, second.id, third.id) as Array<{ id: string; position: number }>;
  assert.deepEqual(rows, [
    { id: second.id, position: 1 },
    { id: first.id, position: 2 },
    { id: third.id, position: 3 }
  ]);
});

test('reordering projects rejects duplicate ids in the requested order', async () => {
  const first = await createProject({ name: 'Duplicate Check One' });
  const second = await createProject({ name: 'Duplicate Check Two' });

  await assert.rejects(
    reorderProjects({ orderedProjectIds: [first.id, first.id] }),
    (err: unknown) => err instanceof ApiError && err.status === 400
  );

  const rows = db
    .prepare(
      `SELECT id, position
         FROM projects
        WHERE id IN (?, ?)
        ORDER BY position ASC`
    )
    .all(first.id, second.id) as Array<{ id: string; position: number }>;
  assert.deepEqual(rows, [
    { id: first.id, position: first.position },
    { id: second.id, position: second.position }
  ]);
});
