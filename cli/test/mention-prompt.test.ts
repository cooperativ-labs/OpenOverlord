import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMentionPromptFrame } from '../src/mention-prompt.ts';

test('renderMentionPromptFrame renders a shaded input row and selected search result', () => {
  const rows = renderMentionPromptFrame({
    buffer: '@agent',
    columns: 12,
    matches: ['AGENTS.md', 'cli/AGENTS.md'],
    prompt: '› ',
    selected: 0
  });

  assert.equal(rows.length, 3);
  assert.match(rows[0] ?? '', /^\x1b\[48;5;236m› @agent\s+\x1b\[0m$/);
  assert.equal(rows[1], '\x1b[36m\x1b[1mAGENTS.md\x1b[0m');
  assert.equal(rows[2], 'cli/AGENTS.md');
});
