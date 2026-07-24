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
  deleteProjectResourceSource,
  getProjectRepository,
  listProjectResources,
  updateProjectResource
} = await import('./repository.ts');
const { getLaunchSettings } = await import('./execution/launch.ts');

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('project resource mutations maintain one primary logical resource per project', async () => {
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
  assert.equal(rows.find(row => row.id === globalResource.id)?.isPrimary, false);
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
  assert.equal(rows.find(row => row.id === firstLocalResource.id)?.isPrimary, false);
});

test('createProjectResource accepts a global git source without execution target', async () => {
  const project = await createProject({ name: 'Global git resource' });

  const resource = await createProjectResource(project.id, {
    sourceUrl: 'https://github.com/example/repo.git',
    resourceKey: 'upstream',
    executionTargetId: null,
    isPrimary: true
  });

  assert.equal(resource.resourceKey, 'upstream');
  assert.equal(resource.sources.length, 1);
  assert.equal(resource.sources[0]?.sourceKind, 'git');
  assert.equal(resource.sources[0]?.executionTargetId, null);
  assert.equal(resource.sources[0]?.descriptor.url, 'https://github.com/example/repo.git');
});

test('createProjectResource accepts a global local checkout source', async () => {
  const project = await createProject({ name: 'Global local resource' });

  const resource = await createProjectResource(project.id, {
    directoryPath: '/tmp/project-global-local',
    resourceKey: 'shared',
    executionTargetId: null,
    isPrimary: false
  });

  assert.equal(resource.sources.length, 1);
  assert.equal(resource.sources[0]?.executionTargetId, null);
  assert.equal(resource.sources[0]?.descriptor.path, '/tmp/project-global-local');
});

test('deleteProjectResourceSource removes only the selected source', async () => {
  const project = await createProject({ name: 'Remove resource source' });
  const resource = await createProjectResource(project.id, {
    directoryPath: '/tmp/remove-source-global',
    resourceKey: 'remove-source',
    executionTargetId: null,
    isPrimary: false
  });
  const withSecondSource = await createProjectResource(project.id, {
    directoryPath: '/tmp/remove-source-local',
    resourceKey: 'remove-source',
    isPrimary: false
  });
  const sourceToRemove = withSecondSource.sources.find(source => source.executionTargetId !== null);
  assert.ok(sourceToRemove);

  await deleteProjectResourceSource(project.id, resource.id, sourceToRemove.id);

  const remaining = (await listProjectResources(project.id)).find(row => row.id === resource.id);
  assert.ok(remaining);
  assert.equal(remaining.sources.length, 1);
  assert.equal(remaining.sources[0]?.executionTargetId, null);
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

test('access mode defaults and primary coercion (coo:368)', async () => {
  const launchSettings = await getLaunchSettings();
  const project = await createProject({ name: 'Access mode behavior' });

  // Primary defaults to read & write.
  const primary = await createProjectResource(project.id, {
    directoryPath: '/tmp/access-primary',
    resourceKey: 'primary',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: true
  });
  assert.equal(primary.accessMode, 'read_write');

  // Non-primary defaults to read when unspecified.
  const reference = await createProjectResource(project.id, {
    directoryPath: '/tmp/access-reference',
    resourceKey: 'reference',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: false
  });
  assert.equal(reference.accessMode, 'read');

  // A primary resource cannot be created as read — it is coerced to read & write.
  const coerced = await createProjectResource(project.id, {
    directoryPath: '/tmp/access-coerced',
    resourceKey: 'coerced',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: true,
    accessMode: 'read'
  });
  assert.equal(coerced.accessMode, 'read_write');

  // A non-primary resource may opt into read & write explicitly.
  const explicitRw = await createProjectResource(project.id, {
    directoryPath: '/tmp/access-explicit',
    resourceKey: 'explicit',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: false,
    accessMode: 'read_write'
  });
  assert.equal(explicitRw.accessMode, 'read_write');

  // Toggling a non-primary resource's access mode is honored.
  const toggled = await updateProjectResource(project.id, reference.id, {
    accessMode: 'read_write'
  });
  assert.equal(toggled.accessMode, 'read_write');
  const backToRead = await updateProjectResource(project.id, reference.id, { accessMode: 'read' });
  assert.equal(backToRead.accessMode, 'read');

  // Promoting a read resource to primary upgrades it to read & write, and a
  // standalone read request against a primary is ignored.
  const promoted = await updateProjectResource(project.id, reference.id, { isPrimary: true });
  assert.equal(promoted.accessMode, 'read_write');
  assert.equal(promoted.isPrimary, true);
  const pinned = await updateProjectResource(project.id, reference.id, { accessMode: 'read' });
  assert.equal(pinned.accessMode, 'read_write');
});
