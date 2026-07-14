import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentResumeCommand } from './agent-resume-command.ts';

test('builds a claude resume command', () => {
  assert.equal(
    buildAgentResumeCommand({ agent: 'claude', sessionId: 'abc-123' }),
    'claude --resume abc-123'
  );
});

test('builds a codex resume command', () => {
  assert.equal(
    buildAgentResumeCommand({ agent: 'codex', sessionId: 'sess_9' }),
    'codex resume sess_9'
  );
});

test('builds a cursor resume command using the launch-time binary', () => {
  assert.equal(
    buildAgentResumeCommand({ agent: 'cursor', sessionId: 'chat-7' }),
    'agent --resume=chat-7'
  );
});

test('builds a PI resume command using its session selector', () => {
  assert.equal(
    buildAgentResumeCommand({ agent: 'pi', sessionId: 'session-42' }),
    'pi --session session-42'
  );
});

test('is case-insensitive on the agent key and trims the session id', () => {
  assert.equal(
    buildAgentResumeCommand({ agent: 'Claude', sessionId: '  abc-123  ' }),
    'claude --resume abc-123'
  );
});

test('returns null when the native session id is missing', () => {
  assert.equal(buildAgentResumeCommand({ agent: 'claude', sessionId: null }), null);
  assert.equal(buildAgentResumeCommand({ agent: 'claude', sessionId: '   ' }), null);
});

test('returns null for an agent without a known resume syntax', () => {
  assert.equal(buildAgentResumeCommand({ agent: 'aider', sessionId: 'abc-123' }), null);
  assert.equal(buildAgentResumeCommand({ agent: null, sessionId: 'abc-123' }), null);
});
