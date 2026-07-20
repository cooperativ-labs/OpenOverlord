import {
  formatProjectResourcePathsFromManifest,
  LAUNCH_VARIABLE_NAMES,
  parseResourcePathEntry,
  parseResourcePathsCsv
} from '@overlord/contract';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPreLaunchVariables,
  substituteLaunchEnvVars,
  substitutePreLaunchVariables
} from '../src/pre-launch.ts';

test('substitutes known placeholders and drops resulting blank lines', () => {
  const result = substitutePreLaunchVariables(
    ['agent-pod file-access set {OVERLORD_PROJECT_RESOURCES_PATHS}', '   {NOTHING_HERE_YET}   '],
    { OVERLORD_PROJECT_RESOURCES_PATHS: '/repo/a:rw,/repo/b:ro', NOTHING_HERE_YET: '' }
  );
  assert.deepEqual(result, ['agent-pod file-access set /repo/a:rw,/repo/b:ro']);
});

test('leaves unknown placeholders verbatim so they stay visible', () => {
  const result = substitutePreLaunchVariables(['echo {NOT_WIRED_YET}'], { MISSION_ID: 'coo:11' });
  assert.deepEqual(result, ['echo {NOT_WIRED_YET}']);
});

test('seeds variables from the launch env plus derived resource paths and cwd', () => {
  const variables = buildPreLaunchVariables({
    launchEnv: { MISSION_ID: 'coo:11', OVERLORD_BACKEND_URL: 'http://127.0.0.1:4310' },
    projectResources: [
      { resourceKey: 'primary', path: '/repo/a', isPrimary: true, accessMode: 'read_write' },
      { resourceKey: 'marketing', path: '/repo/b', accessMode: 'read' },
      { resourceKey: 'disconnected', path: null }
    ],
    workingDirectory: '/repo/a',
    contextFile: '/repo/a/.overlord/tmp/mission-coo-11.md',
    tmpDir: '/repo/a/.overlord/tmp'
  });
  assert.equal(variables.MISSION_ID, 'coo:11');
  assert.equal(variables.OVERLORD_BACKEND_URL, 'http://127.0.0.1:4310');
  assert.equal(variables.OVERLORD_PROJECT_RESOURCES_PATHS, '/repo/a:rw,/repo/b:ro');
  assert.equal(variables.OVERLORD_PROJECT_RESOURCES_PATHS_CSV, '/repo/a:rw,/repo/b:ro');
  assert.equal(variables.OVERLORD_PRIMARY_RESOURCE_PATH, '/repo/a');
  assert.equal(variables.OVERLORD_WORKING_DIRECTORY, '/repo/a');
  assert.equal(variables.OVERLORD_CONTEXT_FILE, '/repo/a/.overlord/tmp/mission-coo-11.md');
  assert.equal(variables.OVERLORD_TMPDIR, '/repo/a/.overlord/tmp');
  assert.equal(variables.TMPDIR, '/repo/a/.overlord/tmp');
  assert.equal(variables.OVERLORD_EXECUTION_REQUEST_ID, '');
});

test('resource paths default to empty when no resources are connected', () => {
  const variables = buildPreLaunchVariables({ launchEnv: {}, projectResources: null });
  assert.equal(variables.OVERLORD_PROJECT_RESOURCES_PATHS, '');
  assert.equal(variables.OVERLORD_PROJECT_RESOURCES_PATHS_CSV, '');
  assert.equal(variables.OVERLORD_PRIMARY_RESOURCE_PATH, '');
});

test('substitutes placeholders inside env-var values and trims names', () => {
  const result = substituteLaunchEnvVars(
    { '  AGENT_POD_EXTRA_ALLOWED_PATHS  ': '{OVERLORD_PROJECT_RESOURCES_PATHS_CSV}' },
    { OVERLORD_PROJECT_RESOURCES_PATHS_CSV: '/repo/a:rw,/repo/b:ro' }
  );
  assert.deepEqual(result, { AGENT_POD_EXTRA_ALLOWED_PATHS: '/repo/a:rw,/repo/b:ro' });
});

test('env-var substitution keeps empty values and leaves unknown placeholders verbatim', () => {
  const result = substituteLaunchEnvVars(
    { EMPTY: '', UNRESOLVED: '{NOT_WIRED_YET}', BLANK_NAME: 'dropped', '   ': 'also dropped' },
    { MISSION_ID: 'coo:11' }
  );
  assert.deepEqual(result, { EMPTY: '', UNRESOLVED: '{NOT_WIRED_YET}', BLANK_NAME: 'dropped' });
});

test('end-to-end: build variables then substitute a pod command', () => {
  const variables = buildPreLaunchVariables({
    launchEnv: {},
    projectResources: [
      { resourceKey: 'primary', path: '/repo/a', isPrimary: true, accessMode: 'read_write' }
    ]
  });
  const commands = substitutePreLaunchVariables(
    ['agent-pod file-access set {OVERLORD_PROJECT_RESOURCES_PATHS}'],
    variables
  );
  assert.deepEqual(commands, ['agent-pod file-access set /repo/a:rw']);
});

test('formatProjectResourcePathsFromManifest emits explicit :rw/:ro suffixes', () => {
  assert.equal(
    formatProjectResourcePathsFromManifest([
      { path: '/repo/a', accessMode: 'read_write' },
      { path: '/repo/b', accessMode: 'read' }
    ]),
    '/repo/a:rw,/repo/b:ro'
  );
  assert.equal(
    formatProjectResourcePathsFromManifest([
      { path: '/repo/a', accessMode: 'read', isPrimary: true }
    ]),
    '/repo/a:rw'
  );
});

test('parseResourcePathsCsv tolerates whitespace and defaults missing suffix to rw', () => {
  assert.deepEqual(parseResourcePathsCsv(' /repo/a:rw , /repo/b:ro , /repo/c '), [
    { path: '/repo/a', permission: 'rw' },
    { path: '/repo/b', permission: 'ro' },
    { path: '/repo/c', permission: 'rw' }
  ]);
  assert.deepEqual(parseResourcePathEntry('/abs/path'), {
    path: '/abs/path',
    permission: 'rw'
  });
});

test('catalog plan_build names are covered by the substitution map', () => {
  const variables = buildPreLaunchVariables({
    launchEnv: {
      MISSION_ID: 'coo:11',
      OVERLORD_MISSION_ID: 'coo:11',
      OVERLORD_BACKEND_URL: 'http://127.0.0.1:4310',
      OVERLORD_EXECUTION_REQUEST_ID: 'req-1',
      OVERLORD_PROJECT_RESOURCES: '[]'
    },
    projectResources: [{ resourceKey: 'primary', path: '/repo/a', isPrimary: true }],
    workingDirectory: '/repo/a',
    contextFile: '/repo/a/.overlord/tmp/mission.md',
    tmpDir: '/repo/a/.overlord/tmp'
  });
  for (const name of LAUNCH_VARIABLE_NAMES) {
    assert.equal(typeof variables[name], 'string', `missing catalog variable ${name}`);
  }
});
