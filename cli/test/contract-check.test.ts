import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import { validateManifest } from '../dist/contract.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const examplesDir = path.join(repoRoot, 'contract', 'examples');

function loadExample(fileName: string): unknown {
  return parseYaml(readFileSync(path.join(examplesDir, fileName), 'utf8'));
}

test('connector example manifest conforms to the schema', () => {
  const errors = validateManifest(loadExample('connector-claude-conformance-manifest.yaml'));
  assert.deepEqual(errors, []);
});

test('extension example manifest conforms to the schema', () => {
  const errors = validateManifest(loadExample('extension-conformance-manifest.yaml'));
  assert.deepEqual(errors, []);
});

test('rest-consumer example manifest conforms to the schema', () => {
  const errors = validateManifest(loadExample('rest-consumer-racecar-conformance-manifest.yaml'));
  assert.deepEqual(errors, []);
});

test('a manifest missing a required field fails with a message naming it', () => {
  const errors = validateManifest({
    contractVersion: '3',
    componentType: 'extension',
    componentKey: 'demo'
    // missing `label`
  });
  assert.ok(errors.some(error => error.includes('label')));
});

test('a manifest with a bad enum value fails with a message naming the allowed values', () => {
  const errors = validateManifest({
    contractVersion: '3',
    componentType: 'bogus',
    componentKey: 'demo',
    label: 'Demo'
  });
  assert.ok(errors.some(error => error.includes('componentType') && error.includes('connector')));
});

test('packaged CLI validates a manifest without node_modules', () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const packagedRoot = mkdtempSync(path.join(tmpdir(), 'ovld-contract-check-'));

  try {
    cpSync(path.join(packageRoot, 'bin'), path.join(packagedRoot, 'bin'), { recursive: true });
    cpSync(path.join(packageRoot, 'dist', 'index.js'), path.join(packagedRoot, 'dist', 'index.js'));
    cpSync(path.join(packageRoot, 'dist', 'contract'), path.join(packagedRoot, 'dist', 'contract'), {
      recursive: true
    });
    writeFileSync(path.join(packagedRoot, 'package.json'), '{"type":"module"}\n');

    const result = spawnSync(
      process.execPath,
      [
        'bin/ovld.mjs',
        'contract',
        'check',
        path.join(examplesDir, 'connector-claude-conformance-manifest.yaml'),
        '--json'
      ],
      { cwd: packagedRoot, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      valid: true,
      manifest: path.join(examplesDir, 'connector-claude-conformance-manifest.yaml'),
      errors: []
    });
  } finally {
    rmSync(packagedRoot, { recursive: true, force: true });
  }
});
