import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { managedFileSourceExists } from '../dist/connector-core-render.js';
import {
  inspectConnector,
  listAvailableConnectors,
  parseConnectorManifestYaml,
  readConnectorManifest,
  setupConnector
} from '../dist/connectors.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ovld-setup-'));
}

test('parseConnectorManifestYaml reads the constrained manifest subset', () => {
  const parsed = parseConnectorManifestYaml(
    [
      'contractVersion: "0"',
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

  assert.equal(parsed.contractVersion, '0');
  assert.equal(parsed.connector.agentIdentifier, 'demo');
  assert.deepEqual(parsed.connector.capabilities, ['followUpHook', 'permissionHook']);
  assert.equal(parsed.connector.installPath, '~/.demo/plugin');
  assert.deepEqual(parsed.connector.managedFiles, ['README.md']);
});

test('claude connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('claude'));
  const manifest = readConnectorManifest('claude');
  assert.ok(manifest.connector.managedFiles.length > 0);
  const sourceDir = path.join(repoRoot, 'connectors', 'adapters', 'claude');
  for (const relativePath of manifest.connector.managedFiles) {
    assert.ok(
      managedFileSourceExists({ sourceDir, relativePath }),
      `missing managed source: ${relativePath}`
    );
  }
});

test('cursor connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('cursor'));
  const manifest = readConnectorManifest('cursor');
  assert.ok(manifest.connector.managedFiles.length > 0);
  const sourceDir = path.join(repoRoot, 'connectors', 'adapters', 'cursor');
  for (const relativePath of manifest.connector.managedFiles) {
    assert.ok(
      managedFileSourceExists({ sourceDir, relativePath }),
      `missing managed source: ${relativePath}`
    );
  }
});

test('codex connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('codex'));
  const manifest = readConnectorManifest('codex');
  assert.ok(manifest.connector.managedFiles.length > 0);
  const sourceDir = path.join(repoRoot, 'connectors', 'adapters', 'codex');
  for (const relativePath of manifest.connector.managedFiles) {
    assert.ok(
      managedFileSourceExists({ sourceDir, relativePath }),
      `missing managed source: ${relativePath}`
    );
  }
});

test('PI connector is available and every managed file exists on disk', () => {
  assert.ok(listAvailableConnectors().includes('pi'));
  const manifest = readConnectorManifest('pi');
  assert.ok(manifest.connector.managedFiles.length > 0);
  const sourceDir = path.join(repoRoot, 'connectors', 'adapters', 'pi');
  for (const relativePath of manifest.connector.managedFiles) {
    assert.ok(
      managedFileSourceExists({ sourceDir, relativePath }),
      `missing managed source: ${relativePath}`
    );
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
    assert.equal(result.binaryName, 'agent');
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

test('PI setup installs its extension and rendered skill without modifying other settings', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'pi', home });
    assert.equal(result.binaryName, 'pi');
    assert.equal(result.installPath, path.join(home, '.pi', 'agent'));
    assert.ok(result.files.every(file => file.action === 'written'));
    assert.ok(existsSync(path.join(result.installPath, 'extensions', 'overlord.ts')));
    assert.ok(
      readFileSync(
        path.join(result.installPath, 'skills', 'overlord-mission', 'SKILL.md'),
        'utf8'
      ).includes('PI Adapter Notes')
    );

    const second = setupConnector({ agentKey: 'pi', home });
    assert.ok(second.files.every(file => file.action === 'unchanged'));
    inspectAndAssertHealthy(home, 'pi');
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
    assert.ok(marketplace.plugins.some((plugin: { name: string }) => plugin.name === 'overlord'));

    const rules = readFileSync(path.join(home, '.codex', 'rules', 'default.rules'), 'utf8');
    assert.ok(rules.includes('pattern = ["ovld", "protocol"]'));

    const hooks = JSON.parse(
      readFileSync(path.join(result.installPath, '.codex-plugin', 'hooks.json'), 'utf8')
    );
    assert.ok(
      hooks.hooks.UserPromptSubmit[0].hooks[0].command.includes('user-prompt-submit-hook.sh')
    );
    assert.ok(hooks.hooks.PermissionRequest[0].hooks[0].command.includes('permission-hook.sh'));

    inspectAndAssertHealthy(home, 'codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('claude setup writes a local marketplace pointing at the installed plugin', () => {
  const home = tempHome();
  try {
    const result = setupConnector({ agentKey: 'claude', home });
    assert.ok(result.files.every(file => file.action === 'written'));

    const marketplacePath = path.join(
      home,
      '.ovld',
      'claude',
      'marketplace',
      '.claude-plugin',
      'marketplace.json'
    );
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    assert.equal(marketplace.name, 'overlord-local');
    const plugin = marketplace.plugins.find((entry: { name: string }) => entry.name === 'overlord');
    assert.ok(plugin, 'overlord plugin entry present');

    // The plugin source must be relative to the marketplace root and resolve to
    // the directory where the managed files were installed.
    assert.ok(plugin.source.startsWith('./'), `relative source, got ${plugin.source}`);
    const resolved = path.resolve(path.dirname(path.dirname(marketplacePath)), plugin.source);
    assert.equal(resolved, result.installPath);
    assert.ok(existsSync(path.join(resolved, '.claude-plugin', 'plugin.json')));

    inspectAndAssertHealthy(home, 'claude');
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
