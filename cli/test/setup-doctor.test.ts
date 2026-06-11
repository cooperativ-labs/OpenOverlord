import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectConnector,
  listAvailableConnectors,
  parseConnectorManifestYaml,
  readConnectorManifest,
  setupConnector
} from '../dist/cli/src/connectors.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ovld-setup-'));
}

test('parseConnectorManifestYaml reads the constrained manifest subset', () => {
  const parsed = parseConnectorManifestYaml(
    [
      'contractVersion: "0.2-draft"',
      'componentKey: demo',
      'connector:',
      '  agentIdentifier: demo',
      '  capabilities:',
      '    - followUpHook',
      '    - permissionHook',
      '  installPath: "~/.demo/plugin"',
      '  managedFiles:',
      '    - "README.md"'
    ].join('\n')
  ) as Record<string, any>;

  assert.equal(parsed.contractVersion, '0.2-draft');
  assert.equal(parsed.connector.agentIdentifier, 'demo');
  assert.deepEqual(parsed.connector.capabilities, ['followUpHook', 'permissionHook']);
  assert.equal(parsed.connector.installPath, '~/.demo/plugin');
  assert.deepEqual(parsed.connector.managedFiles, ['README.md']);
});

test('claude connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('claude'));
  const manifest = readConnectorManifest('claude');
  assert.ok(manifest.connector.managedFiles.length > 0);
  for (const relativePath of manifest.connector.managedFiles) {
    const source = path.join(repoRoot, 'connectors', 'adapters', 'claude', relativePath);
    assert.ok(existsSync(source), `missing managed source: ${relativePath}`);
  }
});

test('cursor connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('cursor'));
  const manifest = readConnectorManifest('cursor');
  assert.ok(manifest.connector.managedFiles.length > 0);
  for (const relativePath of manifest.connector.managedFiles) {
    const source = path.join(repoRoot, 'connectors', 'adapters', 'cursor', relativePath);
    assert.ok(existsSync(source), `missing managed source: ${relativePath}`);
  }
});

test('codex connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('codex'));
  const manifest = readConnectorManifest('codex');
  assert.ok(manifest.connector.managedFiles.length > 0);
  for (const relativePath of manifest.connector.managedFiles) {
    const source = path.join(repoRoot, 'connectors', 'adapters', 'codex', relativePath);
    assert.ok(existsSync(source), `missing managed source: ${relativePath}`);
  }
});

test('setup installs exactly the managed files and is idempotent', () => {
  const home = tempHome();
  try {
    const manifest = readConnectorManifest('claude');
    const first = setupConnector({ agentKey: 'claude', home });
    assert.equal(first.files.length, manifest.connector.managedFiles.length);
    assert.ok(first.files.every(file => file.action === 'written'));

    for (const relativePath of manifest.connector.managedFiles) {
      assert.ok(existsSync(path.join(first.installPath, relativePath)), relativePath);
    }
    assert.ok(existsSync(path.join(home, '.ovld', 'connectors', 'claude.json')));

    const second = setupConnector({ agentKey: 'claude', home });
    assert.ok(second.files.every(file => file.action === 'unchanged'));

    inspectAndAssertHealthy(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cursor setup merges hooks and permission rules', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'cursor', home });
    assert.ok(result.files.every(file => file.action === 'written'));

    const hooks = JSON.parse(readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
    assert.ok(
      hooks.hooks.beforeSubmitPrompt.some((entry: { command: string }) =>
        entry.command.includes('overlord-user-prompt-submit')
      )
    );

    const settings = JSON.parse(readFileSync(path.join(home, '.cursor', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('Shell(ovld protocol:*)'));

    inspectAndAssertHealthy(home, 'cursor');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex setup merges marketplace, rules, and hook commands', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'codex', home });
    assert.ok(result.files.every(file => file.action === 'written'));

    const marketplace = JSON.parse(
      readFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8')
    );
    assert.ok(
      marketplace.plugins.some(
        (plugin: { name: string }) => plugin.name === 'overlord'
      )
    );

    const rules = readFileSync(path.join(home, '.codex', 'rules', 'default.rules'), 'utf8');
    assert.ok(rules.includes('pattern = ["ovld", "protocol"]'));

    const hooks = JSON.parse(
      readFileSync(path.join(result.installPath, '.codex-plugin', 'hooks.json'), 'utf8')
    );
    assert.ok(
      hooks.hooks.UserPromptSubmit[0].hooks[0].command.includes('user-prompt-submit-hook.sh')
    );
    assert.ok(
      hooks.hooks.PermissionRequest[0].hooks[0].command.includes('permission-hook.sh')
    );

    inspectAndAssertHealthy(home, 'codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function inspectAndAssertHealthy(home: string, agentKey = 'claude'): void {
  const report = inspectConnector({ agentKey, home });
  assert.ok(report.installed);
  assert.ok(report.healthy, report.problems.join('; '));
}

test('doctor detects a modified managed file', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'claude', home });
    const target = path.join(result.installPath, 'commands', 'attach.md');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n<!-- tampered -->`);

    const report = inspectConnector({ agentKey: 'claude', home });
    assert.equal(report.healthy, false);
    assert.ok(report.problems.some(problem => problem.includes('commands/attach.md')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor detects a missing managed file', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'claude', home });
    rmSync(path.join(result.installPath, 'prompt-wrapper.md'));

    const report = inspectConnector({ agentKey: 'claude', home });
    assert.equal(report.healthy, false);
    assert.ok(report.problems.some(problem => problem.includes('Missing managed file')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor detects a stale contract version', () => {
  const home = tempHome();
  try {
    setupConnector({ agentKey: 'claude', home });
    const statePath = path.join(home, '.ovld', 'connectors', 'claude.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.contractVersion = '0.0-ancient';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const report = inspectConnector({ agentKey: 'claude', home });
    assert.ok(report.staleContractVersion);
    assert.equal(report.healthy, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('inspect reports not-installed connectors', () => {
  const home = tempHome();
  try {
    const report = inspectConnector({ agentKey: 'claude', home });
    assert.equal(report.installed, false);
    assert.equal(report.healthy, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
