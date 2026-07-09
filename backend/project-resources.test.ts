import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-project-resources-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
const { db } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});
const {
  createProject,
  createProjectResource,
  deleteProjectResource,
  getProjectRepository,
  listProjectResources,
  updateProjectResource
} = await import('./repository.ts');
const { getLaunchSettings } = await import('./execution/launch.ts');

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('project resource mutations keep primaries scoped per execution target', async () => {
  const project = await createProject({ name: 'Web resource mutations' });
  const launchSettings = await getLaunchSettings();

  const globalResource = await createProjectResource(project.id, {
    directoryPath: '/tmp/project-global',
    resourceKey: 'global',
    executionTargetId: null,
    isPrimary: true
  });
  const firstLocalResource = await createProjectResource(project.id, {
    directoryPath: '/tmp/project-local-1',
    resourceKey: 'local-one',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: true
  });
  const secondLocalResource = await createProjectResource(project.id, {
    directoryPath: '/tmp/project-local-2',
    resourceKey: 'local-two',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: false
  });

  await updateProjectResource(project.id, secondLocalResource.id, {
    isPrimary: true,
    resourceKey: 'local-primary'
  });

  let rows = await listProjectResources(project.id);
  assert.equal(rows.find(row => row.id === globalResource.id)?.isPrimary, true);
  assert.equal(rows.find(row => row.id === firstLocalResource.id)?.isPrimary, false);
  assert.equal(rows.find(row => row.id === secondLocalResource.id)?.isPrimary, true);
  assert.equal(rows.find(row => row.id === secondLocalResource.id)?.resourceKey, 'local-primary');

  await deleteProjectResource(project.id, secondLocalResource.id);

  rows = await listProjectResources(project.id);
  assert.equal(
    rows.some(row => row.id === secondLocalResource.id),
    false
  );
  assert.equal(rows.find(row => row.id === globalResource.id)?.isPrimary, true);
  assert.equal(rows.find(row => row.id === firstLocalResource.id)?.isPrimary, true);
});

test('getProjectRepository selects the resource matching the requested key', async () => {
  const primaryDir = mkdtempSync(path.join(tempDir, 'repo-primary-'));
  const secondaryDir = mkdtempSync(path.join(tempDir, 'repo-secondary-'));
  const project = await createProject({ name: 'Repo resource selection' });
  const launchSettings = await getLaunchSettings();

  await createProjectResource(project.id, {
    directoryPath: primaryDir,
    resourceKey: 'primary-key',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: true
  });
  await createProjectResource(project.id, {
    directoryPath: secondaryDir,
    resourceKey: 'secondary-key',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: false
  });

  // No key resolves the project primary.
  const primary = await getProjectRepository(project.id, launchSettings.executionTargetId, null);
  assert.equal(primary.resource?.resourceKey, 'primary-key');

  // A bound key selects the matching resource.
  const bound = await getProjectRepository(
    project.id,
    launchSettings.executionTargetId,
    'secondary-key'
  );
  assert.equal(bound.resource?.resourceKey, 'secondary-key');

  // An unlinked key falls back to the primary rather than returning no resource.
  const fallback = await getProjectRepository(
    project.id,
    launchSettings.executionTargetId,
    'missing-key'
  );
  assert.equal(fallback.resource?.resourceKey, 'primary-key');
});

test('createProject can create an initial primary resource atomically', async () => {
  const resourceDir = mkdtempSync(path.join(tempDir, 'project-create-resource-'));
  const launchSettings = await getLaunchSettings();

  const project = await createProject({
    name: 'Create Project With Resource',
    primaryResource: {
      directoryPath: resourceDir,
      executionTargetId: launchSettings.executionTargetId
    }
  });

  const rows = await listProjectResources(project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.path, resourceDir);
  assert.equal(rows[0]?.resourceKey, path.basename(resourceDir).toLowerCase());
  assert.equal(rows[0]?.isPrimary, true);
  assert.equal(rows[0]?.executionTargetId, launchSettings.executionTargetId);
});
