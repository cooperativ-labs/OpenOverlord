import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-objectives-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db } = await import('./db.ts');
const { createTicket, createProject, updateObjective } = await import('./repository.ts');
const { ApiError } = await import('./errors.ts');

test('clearing a draft objective instruction to empty leaves it blank instead of erroring', () => {
  const project = createProject({ name: 'Clear Instruction Test' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = ticket.objectives[0]!.id;

  const updated = updateObjective(objectiveId, { instructionText: '   ' });

  assert.equal(updated.instructionText, '');
});

test('clearing a submitted objective instruction to empty is still rejected', () => {
  const project = createProject({ name: 'Clear Submitted Instruction Test' });
  const ticket = createTicket({ projectId: project.id, firstObjective: 'Do the thing' });
  const objectiveId = ticket.objectives[0]!.id;
  updateObjective(objectiveId, { state: 'submitted' });

  assert.throws(
    () => updateObjective(objectiveId, { instructionText: '   ' }),
    (err: unknown) => err instanceof ApiError && err.status === 400
  );
});

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
