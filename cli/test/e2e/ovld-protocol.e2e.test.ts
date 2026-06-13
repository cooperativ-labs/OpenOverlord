import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOvld } from '../../../test/support/cli.ts';

function tempDatabaseEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-cli-e2e-'));
  return { OVERLORD_SQLITE_PATH: path.join(dir, 'Overlord.sqlite') };
}

test('ovld protocol attach returns attach-response-v1 JSON', async () => {
  const env = tempDatabaseEnv();
  const init = await runOvld({ args: ['init', '--json'], env });
  assert.equal(init.exitCode, 0);

  const project = await runOvld({
    args: ['create-project', '--name', 'E2E Project', '--json'],
    env
  });
  assert.equal(project.exitCode, 0);
  const projectJson = JSON.parse(project.stdout) as { project: { id: string } };

  const created = await runOvld({
    args: ['create', '--objectives-json', '[{"objective":"E2E attach test"}]', '--json'],
    env
  });
  assert.equal(created.exitCode, 0);
  const createdJson = JSON.parse(created.stdout) as {
    ticket: { displayId: string; id: string };
    objectives: Array<{ id: string }>;
  };

  await runOvld({
    args: ['protocol', 'discuss-objective', '--ticket-id', createdJson.ticket.displayId],
    env
  });

  const attached = await runOvld({
    args: ['protocol', 'attach', '--ticket-id', createdJson.ticket.displayId],
    env
  });
  assert.equal(attached.exitCode, 0, attached.stderr);

  const payload = JSON.parse(attached.stdout) as Record<string, unknown>;
  const payloadTicket = payload.ticket as { statusType?: string } | undefined;
  assert.equal(payloadTicket?.statusType, 'execute');
  for (const field of [
    'history',
    'artifacts',
    'attachments',
    'objectives',
    'session',
    'sharedState',
    'promptContext'
  ]) {
    assert.ok(field in payload, `missing ${field}`);
  }
  assert.match(attached.stderr, /SESSION_KEY=/);
});

test('ovld protocol attach stores external session id', async () => {
  const env = tempDatabaseEnv();
  const init = await runOvld({ args: ['init', '--json'], env });
  assert.equal(init.exitCode, 0);

  await runOvld({
    args: ['create-project', '--name', 'External Session Project', '--json'],
    env
  });

  const created = await runOvld({
    args: ['create', '--objectives-json', '[{"objective":"E2E external session test"}]', '--json'],
    env
  });
  assert.equal(created.exitCode, 0);
  const createdJson = JSON.parse(created.stdout) as { ticket: { displayId: string; id: string } };

  await runOvld({
    args: ['protocol', 'discuss-objective', '--ticket-id', createdJson.ticket.displayId],
    env
  });

  const attached = await runOvld({
    args: [
      'protocol',
      'attach',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--agent',
      'claude',
      '--external-session-id',
      'claude-e2e-session'
    ],
    env
  });
  assert.equal(attached.exitCode, 0, attached.stderr);

  const dbPath = env.OVERLORD_SQLITE_PATH;
  assert.ok(dbPath);
  const db = new Database(dbPath);
  const sessionRow = db
    .prepare(`SELECT external_session_id FROM agent_sessions WHERE ticket_id = ?`)
    .get(createdJson.ticket.id) as { external_session_id: string | null };
  db.close();

  assert.equal(sessionRow.external_session_id, 'claude-e2e-session');
});

test('ovld protocol update without session key exits non-zero', async () => {
  const env = tempDatabaseEnv();
  await runOvld({ args: ['init', '--json'], env });

  const result = await runOvld({
    args: ['protocol', 'update', '--ticket-id', 'local:1', '--summary', 'should fail'],
    env
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /session/i);
});

test('shell-special summary via --summary-file - round-trips', async () => {
  const env = tempDatabaseEnv();
  const init = await runOvld({ args: ['init', '--json'], env });
  assert.equal(init.exitCode, 0);

  await runOvld({ args: ['create-project', '--name', 'Shell Project', '--json'], env });
  const created = await runOvld({
    args: ['create', 'Test `backticks` and $vars', '--json'],
    env
  });
  assert.equal(created.exitCode, 0);
  const createdJson = JSON.parse(created.stdout) as { ticket: { displayId: string } };

  await runOvld({
    args: ['protocol', 'discuss-objective', '--ticket-id', createdJson.ticket.displayId],
    env
  });

  const attached = await runOvld({
    args: ['protocol', 'attach', '--ticket-id', createdJson.ticket.displayId],
    env
  });
  const attachedJson = JSON.parse(attached.stdout) as { sessionKey: string };

  const summary = 'Updated with `ticks` and $HOME preserved';
  const updated = await runOvld({
    args: [
      'protocol',
      'update',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--session-key',
      attachedJson.sessionKey,
      '--summary-file',
      '-'
    ],
    stdin: summary,
    env
  });
  assert.equal(updated.exitCode, 0, updated.stderr);
});
