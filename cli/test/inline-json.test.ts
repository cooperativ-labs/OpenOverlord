import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_INLINE_JSON_CHARS, parseArgs, rejectOversizedInlineJson } from '../src/args.ts';
import { runProtocolCommand } from '../src/commands.ts';
import type { CliRuntime } from '../src/runtime.ts';

test('rejectOversizedInlineJson allows compact inline JSON', () => {
  const flags = parseArgs([
    'deliver',
    '--change-rationales-json',
    '[{"label":"x","file_path":"a.ts","summary":"s","why":"w","impact":"i"}]'
  ]).flags;

  assert.doesNotThrow(() => rejectOversizedInlineJson({ flags }));
});

test('rejectOversizedInlineJson rejects oversized change-rationales-json', () => {
  const oversized = 'x'.repeat(MAX_INLINE_JSON_CHARS + 1);
  const flags = parseArgs(['deliver', '--change-rationales-json', oversized]).flags;

  assert.throws(() => rejectOversizedInlineJson({ flags }), /change-rationales-json is too large/);
  assert.throws(() => rejectOversizedInlineJson({ flags }), /--change-rationales-file -/);
});

test('runProtocolCommand rejects oversized inline JSON before calling the backend', async () => {
  let posted = false;
  const runtime = {
    backend: {
      baseUrl: 'http://example.test',
      health: async () => ({ ok: true }),
      get: async () => {
        throw new Error('unexpected GET');
      },
      post: async () => {
        posted = true;
        return {};
      },
      patch: async () => {
        throw new Error('unexpected PATCH');
      },
      delete: async () => {
        throw new Error('unexpected DELETE');
      }
    },
    close: () => {}
  } satisfies CliRuntime;

  const oversized = 'x'.repeat(MAX_INLINE_JSON_CHARS + 1);

  await assert.rejects(
    () =>
      runProtocolCommand({
        runtime,
        subcommand: 'deliver',
        args: [
          '--session-key',
          'sess_test',
          '--ticket-id',
          'coo:1',
          '--summary',
          'Done.',
          '--change-rationales-json',
          oversized
        ]
      }),
    /--change-rationales-json is too large/
  );
  assert.equal(posted, false);
});
