import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildLaunchPlan } from '../src/launch.ts';
import type { CliRuntime } from '../src/runtime.ts';

function runtime({ title = 'Prompt Capture' }: { title?: string } = {}): CliRuntime {
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
            title,
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
  assert.match(plan.prompt, /immediately execute the current objective/i);
  assert.match(plan.prompt, /Do not wait for more instructions/i);

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

test('buildLaunchPlan substitutes and exports launch env vars before pre-launch commands and the agent', async () => {
  const workingDirectory = mkdtempSync(path.join('/tmp', 'ovld-launch-envvars-'));
  const plan = await buildLaunchPlan({
    runtime: runtime(),
    options: {
      agent: 'codex',
      missionId: 'coo:11',
      workingDirectory,
      terminalLauncher: 'Terminal',
      launchEnvVars: {
        AGENT_POD_EXTRA_ALLOWED_PATHS: 'mission-{MISSION_ID}',
        STATIC_VALUE: 'plain'
      },
      preLaunchCommands: ['echo preparing'],
      executionRequestId: 'request-124'
    }
  });

  // Placeholders in env-var values resolve against the launch context and land in plan.env.
  assert.equal(plan.env.AGENT_POD_EXTRA_ALLOWED_PATHS, 'mission-coo:11');
  assert.equal(plan.env.STATIC_VALUE, 'plain');
  // Overlord's own launch env is preserved alongside user vars.
  assert.equal(plan.env.MISSION_ID, 'coo:11');

  const launchScriptPath = path.join(
    workingDirectory,
    '.overlord',
    'tmp',
    'launch-coo-11-request-124.sh'
  );
  const launchScript = readFileSync(launchScriptPath, 'utf8');
  assert.ok(launchScript.includes(`export AGENT_POD_EXTRA_ALLOWED_PATHS='mission-coo:11'`));
  assert.ok(launchScript.includes(`export STATIC_VALUE='plain'`));

  // Ordering: env exports run before the pre-launch commands, which run before the agent.
  const exportIdx = launchScript.indexOf('export AGENT_POD_EXTRA_ALLOWED_PATHS');
  const preLaunchIdx = launchScript.indexOf('echo preparing');
  const agentIdx = launchScript.indexOf(`'codex'`);
  assert.ok(exportIdx !== -1 && preLaunchIdx !== -1 && agentIdx !== -1);
  assert.ok(exportIdx < preLaunchIdx);
  assert.ok(preLaunchIdx < agentIdx);
});

test('buildLaunchPlan passes PI model and thinking separately with a context file input', async () => {
  const workingDirectory = mkdtempSync(path.join('/tmp', 'ovld-launch-pi-'));
  const plan = await buildLaunchPlan({
    runtime: runtime(),
    options: {
      agent: 'pi',
      missionId: 'coo:11',
      workingDirectory,
      model: 'zai/glm-5.2',
      thinking: 'high',
      flags: [{ name: '--approve' }]
    }
  });

  assert.equal(plan.command, 'pi');
  assert.deepEqual(plan.args, [
    '--model',
    'zai/glm-5.2',
    '--thinking',
    'high',
    '--approve',
    `@${plan.contextFile}`,
    'Attach to ovld mission coo:11, then immediately execute Prompt Capture. Do not wait for more instructions.'
  ]);
  assert.ok(readFileSync(plan.contextFile, 'utf8').includes('# Overlord Mission: coo:11'));
});

test('buildLaunchPlan preserves the execution directive when context uses a file', async () => {
  const workingDirectory = mkdtempSync(path.join('/tmp', 'ovld-launch-long-context-'));
  const plan = await buildLaunchPlan({
    runtime: runtime({ title: 'A'.repeat(4_100) }),
    options: {
      agent: 'codex',
      missionId: 'coo:11',
      workingDirectory
    }
  });

  assert.match(plan.prompt, /context file/i);
  assert.match(plan.prompt, /immediately execute its current objective/i);
  assert.match(plan.prompt, /Do not wait for more instructions/i);
});
