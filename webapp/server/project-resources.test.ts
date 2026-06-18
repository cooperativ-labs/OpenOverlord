import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-project-resources-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const { db } = await import('./db.ts');
const {
  createProject,
  createProjectResource,
  deleteProjectResource,
  listProjectResources,
  updateProjectResource
} = await import('./repository.ts');
const { getLaunchSettings } = await import('./launch.ts');

test('project resource mutations keep primaries scoped per execution target', () => {
  const project = createProject({ name: 'Web resource mutations' });
  const launchSettings = getLaunchSettings();

  const globalResource = createProjectResource(project.id, {
    directoryPath: '/tmp/project-global',
    executionTargetId: null,
    isPrimary: true
  });
  const firstLocalResource = createProjectResource(project.id, {
    directoryPath: '/tmp/project-local-1',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: true
  });
  const secondLocalResource = createProjectResource(project.id, {
    directoryPath: '/tmp/project-local-2',
    executionTargetId: launchSettings.executionTargetId,
    isPrimary: false
  });

  updateProjectResource(project.id, secondLocalResource.id, { isPrimary: true });

  let rows = listProjectResources(project.id);
  assert.equal(rows.find(row => row.id === globalResource.id)?.isPrimary, true);
  assert.equal(rows.find(row => row.id === firstLocalResource.id)?.isPrimary, false);
  assert.equal(rows.find(row => row.id === secondLocalResource.id)?.isPrimary, true);

  deleteProjectResource(project.id, secondLocalResource.id);

  rows = listProjectResources(project.id);
  assert.equal(
    rows.some(row => row.id === secondLocalResource.id),
    false
  );
  assert.equal(rows.find(row => row.id === globalResource.id)?.isPrimary, true);
  assert.equal(rows.find(row => row.id === firstLocalResource.id)?.isPrimary, true);

  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
