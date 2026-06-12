import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseAgentCatalogFromToml, resolveInstanceAgentCatalog } from '../src/agent-catalog.ts';
import { BUNDLED_AGENT_CATALOG } from '../src/agent-catalog-defaults.ts';
import { loadConfig } from '../src/config.ts';

test('loadConfig parses scalar keys from overlord.toml', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(
    configPath,
    `instance_name = "Test Instance"
database_path = "db.sqlite"
web_host = "0.0.0.0"
web_port = 9999
sql_studio_enabled = true
sql_studio_host = "127.0.0.1"
sql_studio_port = 3030
sql_studio_binary = "/opt/sql-studio/bin/sql-studio"
default_agent = "codex"
default_model = "gpt-5"
`
  );

  const config = loadConfig(configPath);
  assert.equal(config.instanceName, 'Test Instance');
  assert.equal(config.databasePath, 'db.sqlite');
  assert.equal(config.webHost, '0.0.0.0');
  assert.equal(config.webPort, 9999);
  assert.equal(config.sqlStudioEnabled, true);
  assert.equal(config.sqlStudioHost, '127.0.0.1');
  assert.equal(config.sqlStudioPort, 3030);
  assert.equal(config.sqlStudioBinary, '/opt/sql-studio/bin/sql-studio');
  assert.equal(config.defaultAgent, 'codex');
  assert.equal(config.defaultModel, 'gpt-5');
  assert.equal(config.agentCatalog, null);
});

test('loadConfig parses agent_catalog tables', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(
    configPath,
    `default_agent = "claude"

[agent_catalog.claude]
label = "My Claude"
available_by_default = true
reasoning_label = "Thinking"

[[agent_catalog.claude.models]]
id = "claude-sonnet-4-6"
display_name = "Sonnet 4.6"
reasoning_options = ["low", "high"]
`
  );

  const config = loadConfig(configPath);
  assert.ok(config.agentCatalog);
  assert.equal(config.agentCatalog?.claude.label, 'My Claude');
  assert.deepEqual(config.agentCatalog?.claude.models, [
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Sonnet 4.6',
      reasoningOptions: ['low', 'high']
    }
  ]);
});

test('resolveInstanceAgentCatalog merges config over bundled defaults', () => {
  const resolved = resolveInstanceAgentCatalog({
    configCatalog: {
      claude: {
        label: 'Custom Claude',
        availableByDefault: false,
        models: [
          {
            id: 'claude-sonnet-4-6',
            displayName: 'Sonnet only',
            reasoningOptions: ['medium']
          }
        ],
        defaultModel: 'claude-sonnet-4-6',
        defaultReasoningEffort: 'medium',
        reasoningLabel: 'Thinking'
      }
    }
  });

  assert.equal(resolved.claude.label, 'Custom Claude');
  assert.equal(resolved.claude.availableByDefault, false);
  assert.equal(resolved.claude.defaultModel, 'claude-sonnet-4-6');
  assert.equal(resolved.codex.label, BUNDLED_AGENT_CATALOG.codex.label);
});

test('parseAgentCatalogFromToml ignores invalid agents', () => {
  assert.deepEqual(
    parseAgentCatalogFromToml({
      broken: { label: 'No models' },
      good: {
        label: 'Good',
        models: [{ id: 'model-a', display_name: 'Model A' }]
      }
    }),
    {
      good: {
        label: 'Good',
        availableByDefault: true,
        models: [{ id: 'model-a', displayName: 'Model A', reasoningOptions: [] }],
        defaultModel: null,
        defaultReasoningEffort: null,
        reasoningLabel: 'Thinking'
      }
    }
  );
});
