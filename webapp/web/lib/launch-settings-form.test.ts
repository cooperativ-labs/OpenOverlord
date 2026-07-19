import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEnvVarRow,
  envVarsEqual,
  envVarsFromRows,
  envVarsToText,
  mergeEnvVarPasteIntoRows,
  parseEnvVarLines,
  parseEnvVarPaste,
  parsePreLaunchLines,
  rowsFromEnvVars
} from '../components/projects/project-settings/launch-settings-form.ts';

describe('launch-settings-form', () => {
  it('parses valid env var lines', () => {
    assert.deepEqual(
      parseEnvVarLines('AGENT_POD_EXTRA_ALLOWED_PATHS={OVERLORD_PROJECT_RESOURCES_PATHS_CSV}'),
      { AGENT_POD_EXTRA_ALLOWED_PATHS: '{OVERLORD_PROJECT_RESOURCES_PATHS_CSV}' }
    );
  });

  it('round-trips env vars through text', () => {
    const vars = { FOO: 'bar', BAZ: '{MISSION_ID}' };
    assert.deepEqual(parseEnvVarLines(envVarsToText(vars)), vars);
  });

  it('builds rows from env vars and back', () => {
    const rows = rowsFromEnvVars({
      B: 'two',
      A: 'one'
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].key, 'A');
    assert.deepEqual(envVarsFromRows(rows), { A: 'one', B: 'two' });
  });

  it('parses multiline paste into multiple rows', () => {
    const rows = parseEnvVarPaste(
      'FOO=bar\nAGENT_POD_EXTRA_ALLOWED_PATHS={OVERLORD_PROJECT_RESOURCES_PATHS_CSV}'
    );
    assert.deepEqual(
      rows?.map(row => ({ key: row.key, value: row.value })),
      [
        { key: 'FOO', value: 'bar' },
        { key: 'AGENT_POD_EXTRA_ALLOWED_PATHS', value: '{OVERLORD_PROJECT_RESOURCES_PATHS_CSV}' }
      ]
    );
  });

  it('merges single-line paste into the active row', () => {
    const rows = [
      createEnvVarRow({ key: 'OLD', value: 'value' }),
      createEnvVarRow({ key: '', value: '' })
    ];
    const merged = mergeEnvVarPasteIntoRows({
      rows,
      rowIndex: 1,
      text: 'NEW=next'
    });
    assert.deepEqual(
      merged?.map(row => ({ key: row.key, value: row.value })),
      [
        { key: 'OLD', value: 'value' },
        { key: 'NEW', value: 'next' }
      ]
    );
  });

  it('replaces all rows when pasting multiple lines', () => {
    const rows = [createEnvVarRow({ key: 'OLD', value: 'value' })];
    const merged = mergeEnvVarPasteIntoRows({
      rows,
      rowIndex: 0,
      text: 'ONE=1\nTWO=2'
    });
    assert.deepEqual(
      merged?.map(row => ({ key: row.key, value: row.value })),
      [
        { key: 'ONE', value: '1' },
        { key: 'TWO', value: '2' }
      ]
    );
  });

  it('compares env var maps regardless of key order', () => {
    assert.equal(envVarsEqual({ A: '1', B: '2' }, { B: '2', A: '1' }), true);
    assert.equal(envVarsEqual({ A: '1' }, { A: '2' }), false);
  });

  it('parses pre-launch command lines', () => {
    assert.deepEqual(parsePreLaunchLines('echo one\n\n echo two '), ['echo one', 'echo two']);
  });
});
