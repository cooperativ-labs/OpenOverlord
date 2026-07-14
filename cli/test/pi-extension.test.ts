import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('PI extension skips the injected launch input and publishes later user input', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ovld-pi-extension-'));
  const previous = {
    home: process.env.HOME,
    missionId: process.env.MISSION_ID,
    executionRequestId: process.env.OVERLORD_EXECUTION_REQUEST_ID,
    sessionKey: process.env.SESSION_KEY
  };
  process.env.HOME = home;
  process.env.MISSION_ID = 'coo:pi-test';
  process.env.OVERLORD_EXECUTION_REQUEST_ID = 'request-123';
  process.env.SESSION_KEY = 'session-key';

  try {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const calls: Array<{ command: string; args: string[] }> = [];
    const module = await import('../../connectors/adapters/pi/extensions/overlord.ts');
    module.default({
      on(event: string, handler: (event: any, ctx: any) => any) {
        handlers.set(event, handler);
      },
      exec(command: string, args: string[]) {
        calls.push({ command, args });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
    } as any);

    const input = handlers.get('input');
    assert.ok(input);
    const ctx = {
      cwd: '/workspace/project',
      sessionManager: { getSessionId: () => 'pi-session-42' }
    };

    assert.deepEqual(input!({ source: 'interactive', text: 'Start work' }, ctx), {
      action: 'continue'
    });
    assert.equal(calls.length, 0);

    assert.deepEqual(input!({ source: 'interactive', text: 'Please continue' }, ctx), {
      action: 'continue'
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, [
      {
        command: 'ovld',
        args: [
          'protocol',
          'hook-event',
          '--hook-type',
          'UserPromptSubmit',
          '--mission-id',
          'coo:pi-test',
          '--prompt',
          'Please continue',
          '--turn-index',
          '1',
          '--external-session-id',
          'pi-session-42',
          '--session-key',
          'session-key'
        ]
      }
    ]);
  } finally {
    restoreEnv('HOME', previous.home);
    restoreEnv('MISSION_ID', previous.missionId);
    restoreEnv('OVERLORD_EXECUTION_REQUEST_ID', previous.executionRequestId);
    restoreEnv('SESSION_KEY', previous.sessionKey);
    rmSync(home, { recursive: true, force: true });
  }
});
