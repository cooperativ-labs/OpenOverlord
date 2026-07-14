import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
