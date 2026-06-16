import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runOvld } from '../../../test/support/cli.ts';

function tempDatabaseEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join('/tmp', 'open-overlord-cli-e2e-'));
  return { OVERLORD_SQLITE_PATH: path.join(dir, 'Overlord.sqlite') };
}

test('ovld protocol attach returns attach-response-v1 JSON', async () => {
  const env = tempDatabaseEnv();
  const init = await runOvld({ args: ['init', '--json'], env });
  assert.equal(init.exitCode, 0);

  const project = await runOvld({
    args: ['create-project', '--name', 'E2E Project', '--no-directory', '--json'],
    env
  });
  assert.equal(project.exitCode, 0);
  const projectJson = JSON.parse(project.stdout) as { project: { id: string } };

  const created = await runOvld({
    args: [
      'protocol',
      'create',
      '--project-id',
      projectJson.project.id,
      '--objective',
      'E2E attach test'
    ],
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

  const project = await runOvld({
    args: ['create-project', '--name', 'External Session Project', '--no-directory', '--json'],
    env
  });
  assert.equal(project.exitCode, 0, project.stderr);
  const projectJson = JSON.parse(project.stdout) as { project: { id: string } };

  const created = await runOvld({
    args: [
      'protocol',
      'create',
      '--project-id',
      projectJson.project.id,
      '--objective',
      'E2E external session test'
    ],
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

  const project = await runOvld({
    args: ['create-project', '--name', 'Shell Project', '--no-directory', '--json'],
    env
  });
  assert.equal(project.exitCode, 0, project.stderr);
  const projectJson = JSON.parse(project.stdout) as { project: { id: string } };
  const created = await runOvld({
    args: [
      'protocol',
      'create',
      '--project-id',
      projectJson.project.id,
      '--objective',
      'Test `backticks` and $vars'
    ],
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

test('post-delivery hook-event records discussion and resume-follow-up reopens work', async () => {
  const env = tempDatabaseEnv();
  const init = await runOvld({ args: ['init', '--json'], env });
  assert.equal(init.exitCode, 0);

  const project = await runOvld({
    args: ['create-project', '--name', 'Follow Up Project', '--no-directory', '--json'],
    env
  });
  assert.equal(project.exitCode, 0, project.stderr);
  const projectJson = JSON.parse(project.stdout) as { project: { id: string } };
  const created = await runOvld({
    args: [
      'protocol',
      'create',
      '--project-id',
      projectJson.project.id,
      '--objective',
      'Initial follow-up target'
    ],
    env
  });
  assert.equal(created.exitCode, 0, created.stderr);
  const createdJson = JSON.parse(created.stdout) as {
    ticket: { id: string; displayId: string };
    objectives: Array<{ id: string }>;
  };
  const objectiveId = createdJson.objectives[0].id;

  const attached = await runOvld({
    args: [
      'protocol',
      'attach',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--external-session-id',
      'native-followup-session'
    ],
    env
  });
  assert.equal(attached.exitCode, 0, attached.stderr);
  const attachedJson = JSON.parse(attached.stdout) as { sessionKey: string };

  const delivered = await runOvld({
    args: [
      'protocol',
      'deliver',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--session-key',
      attachedJson.sessionKey,
      '--summary',
      'Initial delivery'
    ],
    env
  });
  assert.equal(delivered.exitCode, 0, delivered.stderr);

  const hook = await runOvld({
    args: [
      'protocol',
      'hook-event',
      '--hook-type',
      'UserPromptSubmit',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--prompt-file',
      '-',
      '--turn-index',
      '2',
      '--external-session-id',
      'native-followup-session',
      '--session-key',
      attachedJson.sessionKey
    ],
    stdin: 'Please tweak the docs.',
    env
  });
  assert.equal(hook.exitCode, 0, hook.stderr);
  const hookJson = JSON.parse(hook.stdout) as { objectiveId: string; sessionId: string };
  assert.equal(hookJson.objectiveId, objectiveId);
  assert.ok(hookJson.sessionId);

  const dbPath = env.OVERLORD_SQLITE_PATH;
  assert.ok(dbPath);
  const db = new Database(dbPath);
  const discussionState = db
    .prepare(`SELECT state FROM objectives WHERE id = ?`)
    .get(objectiveId) as { state: string };
  const eventRow = db
    .prepare(
      `SELECT type, summary FROM ticket_events WHERE objective_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(objectiveId) as { type: string; summary: string };
  assert.equal(discussionState.state, 'complete');
  assert.equal(eventRow.type, 'user_follow_up');
  assert.equal(eventRow.summary, 'Please tweak the docs.');

  const attachAfterComplete = await runOvld({
    args: ['protocol', 'attach', '--ticket-id', createdJson.ticket.displayId],
    env
  });
  assert.notEqual(attachAfterComplete.exitCode, 0);
  assert.match(attachAfterComplete.stderr, /No active objective/);

  const resumed = await runOvld({
    args: [
      'protocol',
      'resume-follow-up',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--external-session-id',
      'native-followup-session',
      '--summary',
      'Beginning follow-up work.'
    ],
    env
  });
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  const resumedJson = JSON.parse(resumed.stdout) as {
    sessionKey: string;
    objective: { id: string; state: string };
    session: { deliveryState: string };
  };
  assert.equal(resumedJson.objective.id, objectiveId);
  assert.equal(resumedJson.objective.state, 'pending_delivery');
  assert.equal(resumedJson.session.deliveryState, 'pending_redelivery');

  const updated = await runOvld({
    args: [
      'protocol',
      'update',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--session-key',
      resumedJson.sessionKey,
      '--summary',
      'Changed docs.',
      '--changed-files-json',
      '[{"filePath":"docs/example.md","vcsStatus":"modified"}]'
    ],
    env
  });
  assert.equal(updated.exitCode, 0, updated.stderr);

  const redelivered = await runOvld({
    args: [
      'protocol',
      'deliver',
      '--ticket-id',
      createdJson.ticket.displayId,
      '--session-key',
      resumedJson.sessionKey,
      '--summary',
      'Follow-up delivery',
      '--change-rationales-json',
      '[{"file_path":"docs/example.md","label":"Update docs","summary":"Updated docs.","why":"User requested a follow-up tweak.","impact":"Records the follow-up change."}]'
    ],
    env
  });
  assert.equal(redelivered.exitCode, 0, redelivered.stderr);

  const finalState = db.prepare(`SELECT state FROM objectives WHERE id = ?`).get(objectiveId) as {
    state: string;
  };
  const deliveryCount = db
    .prepare(`SELECT COUNT(*) AS count FROM deliveries WHERE objective_id = ?`)
    .get(objectiveId) as { count: number };
  db.close();

  assert.equal(finalState.state, 'complete');
  assert.equal(deliveryCount.count, 2);
});
