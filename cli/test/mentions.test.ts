import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findActiveMention,
  fuzzyMatchFiles,
  getCollapsedFileMentionLabel,
  insertMention
} from '../src/mentions.ts';

test('getCollapsedFileMentionLabel keeps short paths and collapses deep ones', () => {
  assert.equal(getCollapsedFileMentionLabel('README.md'), 'README.md');
  assert.equal(getCollapsedFileMentionLabel('cli/mentions.ts'), 'cli/mentions.ts');
  assert.equal(getCollapsedFileMentionLabel('cli/src/mentions.ts'), 'cli/…/mentions.ts');
  assert.equal(
    getCollapsedFileMentionLabel('webapp/web/components/MentionableTextarea.tsx'),
    'webapp/…/MentionableTextarea.tsx'
  );
});

test('findActiveMention detects an in-progress mention at the cursor', () => {
  assert.deepEqual(findActiveMention('@cli', 4), { start: 0, query: 'cli' });
  assert.deepEqual(findActiveMention('fix @src/a', 10), { start: 4, query: 'src/a' });
  assert.deepEqual(findActiveMention('bare @', 6), { start: 5, query: '' });
});

test('findActiveMention returns null when there is no open mention', () => {
  assert.equal(findActiveMention('no mention here', 15), null);
  // A space after the token closes the mention.
  assert.equal(findActiveMention('@done now', 9), null);
  // An email-like `@` mid-token is not a boundary mention.
  assert.equal(findActiveMention('me@host', 7), null);
});

test('fuzzyMatchFiles filters by substring and caps results', () => {
  const files = ['src/a.ts', 'src/b.ts', 'docs/c.md', 'README.md'];
  assert.deepEqual(fuzzyMatchFiles(files, 'src'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(fuzzyMatchFiles(files, 'README'), ['README.md']);
  assert.deepEqual(fuzzyMatchFiles(files, ''), files);
  assert.equal(fuzzyMatchFiles(files, 'b', 1).length, 1);
});

test('insertMention replaces the active token and adds a trailing space', () => {
  const mention = findActiveMention('look at @cli', 12);
  assert.ok(mention);
  const result = insertMention('look at @cli', mention, 'cli/src/mentions.ts', 12);
  assert.equal(result.text, 'look at @cli/src/mentions.ts ');
  assert.equal(result.cursor, result.text.length);
});

test('insertMention does not double a space when one already follows', () => {
  const mention = findActiveMention('@a rest', 2);
  assert.ok(mention);
  const result = insertMention('@a rest', mention, 'alpha.ts', 2);
  assert.equal(result.text, '@alpha.ts rest');
});
