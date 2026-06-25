import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

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
});

test('createProject can create an initial primary resource atomically', () => {
  const resourceDir = mkdtempSync(path.join(tempDir, 'project-create-resource-'));
  const launchSettings = getLaunchSettings();

  const project = createProject({
    name: 'Create Project With Resource',
    primaryResource: {
      directoryPath: resourceDir,
      executionTargetId: launchSettings.executionTargetId
    }
  });

  const rows = listProjectResources(project.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.path, resourceDir);
  assert.equal(rows[0]?.isPrimary, true);
  assert.equal(rows[0]?.executionTargetId, launchSettings.executionTargetId);

  const projectJsonPath = path.join(resourceDir, '.overlord', 'project.json');
  assert.equal(existsSync(projectJsonPath), true);
  const projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
    projectId: string;
    resourceId: string;
    isPrimary: boolean;
  };
  assert.equal(projectJson.projectId, project.id);
  assert.equal(projectJson.resourceId, rows[0]?.id);
  assert.equal(projectJson.isPrimary, true);
});
