import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-projects-'));
const { DEFAULT_TEST_ORGANIZATION_ID, bootstrapIntegrationTestDb } =
  await import('./test-helpers.ts');
const { WORKSPACE, operatorWorkspaceUserId } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});
const primaryWorkspaceId = WORKSPACE.id;

const { db, resolveActorForWorkspace, setActiveWorkspace, setActiveWorkspaceUser } =
  await import('./db.ts');
const {
  createMission,
  createProject,
  getProject,
  listMissions,
  listProjects,
  listProjectsForWorkspace,
  listWorkspaceStatuses,
  listWorkspaceStatusesForWorkspace,
  reorderProjects
} = await import('./repository.ts');
const { createWorkspace } = await import('./workspaces.ts');
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

test('createProject honors an explicit non-active workspace target', async () => {
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Secondary Project Target'
  });

  await setActiveWorkspace(primaryWorkspaceId);
  setActiveWorkspaceUser(operatorWorkspaceUserId);

  const created = await createProject({
    name: 'Secondary Workspace Project',
    workspaceId: secondary.id
  });

  assert.equal(created.workspaceId, secondary.id);
  assert.deepEqual(
    (await listProjects()).map(project => project.id).includes(created.id),
    false,
    'active workspace project list should not include the secondary project'
  );
  assert.deepEqual(
    (await listProjectsForWorkspace(secondary.id)).map(project => project.id),
    [created.id]
  );
});

test('project reads use the project workspace instead of the active workspace', async () => {
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Secondary Project Reads'
  });
  const secondaryWorkspaceUserId = await resolveActorForWorkspace(secondary.id);
  assert.ok(secondaryWorkspaceUserId);
  setActiveWorkspaceUser(secondaryWorkspaceUserId);

  const project = await createProject({ name: 'Secondary Read Project' });
  await createMission({
    projectId: project.id,
    title: 'Secondary Mission',
    objectives: [{ objective: 'Keep secondary project readable.' }]
  });
  const secondaryStatuses = await listWorkspaceStatuses();

  await setActiveWorkspace(primaryWorkspaceId);
  setActiveWorkspaceUser(operatorWorkspaceUserId);

  assert.equal((await getProject(project.id)).workspaceId, secondary.id);
  assert.deepEqual(
    (await listMissions(project.id)).map(mission => mission.title),
    ['Secondary Mission']
  );
  assert.deepEqual(await listWorkspaceStatusesForWorkspace(secondary.id), secondaryStatuses);
});
