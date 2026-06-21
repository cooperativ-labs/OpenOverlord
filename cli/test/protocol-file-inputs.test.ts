import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProtocolFileInputs } from '../src/commands.ts';

test('per-flag file payloads no longer collide on a single stdin field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovld-file-inputs-'));
  const rationalesPath = path.join(dir, 'rationales.json');
  writeFileSync(rationalesPath, '[{"file_path":"a.ts"}]', 'utf8');

  const flags = new Map<string, string | true>([
    ['--summary-file', '-'],
    ['--change-rationales-file', rationalesPath]
  ]);

  const { fileInputs, stdin } = await resolveProtocolFileInputs({
    flags,
    stdin: 'A long summary streamed on stdin.'
  });

  // The summary came from stdin; the rationales came from the real file path.
  assert.equal(fileInputs['--summary-file'], 'A long summary streamed on stdin.');
  assert.equal(fileInputs['--change-rationales-file'], '[{"file_path":"a.ts"}]');
  // The lone '-' payload is mirrored to `stdin` for backward compatibility.
  assert.equal(stdin, 'A long summary streamed on stdin.');
});

test('passing two stdin (-) flags fails fast and names both flags', async () => {
  const flags = new Map<string, string | true>([
    ['--summary-file', '-'],
    ['--change-rationales-file', '-']
  ]);

  await assert.rejects(
    () => resolveProtocolFileInputs({ flags, stdin: 'payload' }),
    (err: Error) => {
      assert.match(err.message, /--summary-file/);
      assert.match(err.message, /--change-rationales-file/);
      assert.match(err.message, /stdin/i);
      return true;
    }
  );
});

test('no file flags preserves a piped stdin payload (legacy behavior)', async () => {
  const flags = new Map<string, string | true>();
  const { fileInputs, stdin } = await resolveProtocolFileInputs({
    flags,
    stdin: 'legacy single payload'
  });

  assert.deepEqual(fileInputs, {});
  assert.equal(stdin, 'legacy single payload');
});
