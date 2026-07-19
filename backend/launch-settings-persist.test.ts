import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('project launch settings persistence', () => {
  it('persists preLaunchCommands and launchEnvVars in settings_json', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-launch-settings-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });
    const { createProject, updateProject, getProject } = await import('./repository.ts');

    const project = await createProject({ name: 'Launch Settings Test' });
    const updated = await updateProject(project.id, {
      preLaunchCommands: ['echo hello'],
      launchEnvVars: { AGENT_POD_EXTRA_ALLOWED_PATHS: '{OVERLORD_PROJECT_RESOURCES_PATHS}' }
    });
    assert.deepEqual(updated.preLaunchCommands, ['echo hello']);
    assert.deepEqual(updated.launchEnvVars, {
      AGENT_POD_EXTRA_ALLOWED_PATHS: '{OVERLORD_PROJECT_RESOURCES_PATHS}'
    });

    const reloaded = await getProject(project.id);
    assert.deepEqual(reloaded.preLaunchCommands, ['echo hello']);
    assert.deepEqual(reloaded.launchEnvVars, {
      AGENT_POD_EXTRA_ALLOWED_PATHS: '{OVERLORD_PROJECT_RESOURCES_PATHS}'
    });
  });
});
