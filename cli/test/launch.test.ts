import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildLaunchPlan } from '../src/launch.ts';
import type { CliRuntime } from '../src/runtime.ts';

function runtime(): CliRuntime {
  return {
    backend: {
      baseUrl: 'http://127.0.0.1:4310',
      health: async () => ({ ok: true }),
      get: async <T>(requestPath: string): Promise<T> => {
        if (requestPath.startsWith('/api/missions/') && requestPath.endsWith('/events')) {
          return [] as T;
        }
        if (requestPath.startsWith('/api/missions/') && requestPath.endsWith('/artifacts')) {
          return [] as T;
        }
        if (requestPath.startsWith('/api/objectives/') && requestPath.endsWith('/attachments')) {
          return [] as T;
        }
        if (requestPath.startsWith('/api/missions/')) {
          return {
            id: 'mission-uuid',
            displayId: 'coo:11',
            title: 'Prompt Capture',
            objectives: [{ id: 'objective-uuid', state: 'executing', instructionText: 'Ship it' }]
          } as T;
        }
        throw new Error(`Unexpected GET ${requestPath}`);
      },
      post: async () => {
        throw new Error('Unexpected POST');
      },
      patch: async () => {
        throw new Error('Unexpected PATCH');
      },
      delete: async () => {
        throw new Error('Unexpected DELETE');
      }
    },
    close: () => {}
  };
}

test('buildLaunchPlan exports mission context for terminal prompt hooks', async () => {
  const workingDirectory = mkdtempSync(path.join('/tmp', 'ovld-launch-env-'));
  const plan = await buildLaunchPlan({
    runtime: runtime(),
    options: {
      agent: 'codex',
      missionId: 'coo:11',
      workingDirectory,
      terminalLauncher: 'Terminal',
      executionRequestId: 'request-123'
    }
  });

  assert.equal(plan.env.MISSION_ID, 'coo:11');
  assert.equal(plan.env.OVERLORD_MISSION_ID, 'coo:11');
  assert.equal(plan.env.OVERLORD_BACKEND_URL, 'http://127.0.0.1:4310');
  assert.equal(plan.env.OVERLORD_EXECUTION_REQUEST_ID, 'request-123');

  const script = plan.execution.args[1] ?? '';
  const launchScriptPath = path.join(
    workingDirectory,
    '.overlord',
    'tmp',
    'launch-coo-11-request-123.sh'
  );
  assert.ok(script.includes(`/bin/bash '${launchScriptPath}'`));
  assert.ok(!script.includes(`export MISSION_ID='coo:11'`));

  const mode = statSync(launchScriptPath).mode & 0o777;
  assert.equal(mode, 0o700);
  const launchScript = readFileSync(launchScriptPath, 'utf8');
  assert.ok(launchScript.includes(`cd '${workingDirectory}'`));
  assert.ok(launchScript.includes(`export MISSION_ID='coo:11'`));
  assert.ok(launchScript.includes(`export OVERLORD_BACKEND_URL='http://127.0.0.1:4310'`));
  assert.ok(launchScript.includes(`'codex'`));
});
