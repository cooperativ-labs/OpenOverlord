import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseAgentCatalogFromToml, resolveInstanceAgentCatalog } from '../src/agent-catalog.ts';
import { BUNDLED_AGENT_CATALOG } from '../src/agent-catalog-defaults.ts';
import {
  DEFAULT_LOCAL_BACKEND_URL,
  loadConfig,
  resolveBackendUrl,
  resolveDatabasePath,
  writeConfig
} from '../src/config.ts';
import { isInstalledModulePath, resetExplicitRuntimeEnvForTests } from '../src/env.ts';

test('isInstalledModulePath flags installed packages but not the source build', () => {
  // An installed/published CLI runs as production and must never read the dev-only
  // OVERLORD_BACKEND_URL_DEV; the in-repo source build stays development.
  assert.equal(
    isInstalledModulePath('/Users/x/.nvm/versions/node/v24/lib/node_modules/open-overlord/dist'),
    true
  );
  assert.equal(isInstalledModulePath('/Users/x/Development/OpenOverlord/cli/dist'), false);
  assert.equal(isInstalledModulePath('/Users/x/Development/OpenOverlord/cli/src'), false);
});

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

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  const previousDevBackendUrl = process.env.OVERLORD_BACKEND_URL_DEV;
  delete process.env.OVERLORD_BACKEND_URL;
  delete process.env.OVERLORD_BACKEND_URL_DEV;
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath);
    assert.equal(config.instanceName, 'Test Instance');
    assert.equal(config.backendMode, 'local');
    assert.equal(resolveBackendUrl(config), DEFAULT_LOCAL_BACKEND_URL);
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
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    if (previousDevBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL_DEV;
    else process.env.OVERLORD_BACKEND_URL_DEV = previousDevBackendUrl;
  }
});

test('defaults to the global database when database_path is unset', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-home-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `instance_name = "Global"\n`);

  const previousHome = process.env.OVLD_HOME;
  const previousSqlite = process.env.OVERLORD_SQLITE_PATH;
  process.env.OVLD_HOME = home;
  delete process.env.OVERLORD_SQLITE_PATH;
  try {
    const config = loadConfig(configPath);
    assert.equal(config.databasePath, null);
    assert.equal(config.databaseUrl, null);
    assert.equal(resolveDatabasePath(config, dir), path.join(home, 'Overlord.sqlite'));
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
    if (previousSqlite === undefined) delete process.env.OVERLORD_SQLITE_PATH;
    else process.env.OVERLORD_SQLITE_PATH = previousSqlite;
  }
});

test('expands a leading ~ in database_path to the home directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `database_path = "~/.ovld/Overlord.sqlite"\n`);

  const previousSqlite = process.env.OVERLORD_SQLITE_PATH;
  delete process.env.OVERLORD_SQLITE_PATH;
  try {
    const config = loadConfig(configPath);
    assert.equal(config.databasePath, '~/.ovld/Overlord.sqlite');
    assert.equal(
      resolveDatabasePath(config, dir),
      path.join(homedir(), '.ovld', 'Overlord.sqlite')
    );
  } finally {
    if (previousSqlite === undefined) delete process.env.OVERLORD_SQLITE_PATH;
    else process.env.OVERLORD_SQLITE_PATH = previousSqlite;
  }
});

test('backend_url selects the configured backend target', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(
    configPath,
    `backend_mode = "cloud"
backend_url = "https://overlord.example.com"
`
  );

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  const previousDevBackendUrl = process.env.OVERLORD_BACKEND_URL_DEV;
  delete process.env.OVERLORD_BACKEND_URL;
  delete process.env.OVERLORD_BACKEND_URL_DEV;
  try {
    const config = loadConfig(configPath);
    assert.equal(config.backendMode, 'cloud');
    assert.equal(config.backendUrl, 'https://overlord.example.com');
    assert.equal(resolveBackendUrl(config), 'https://overlord.example.com');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    if (previousDevBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL_DEV;
    else process.env.OVERLORD_BACKEND_URL_DEV = previousDevBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('an explicit runtime OVERLORD_BACKEND_URL beats overlord.toml', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `backend_url = "http://127.0.0.1:4310"\n`);

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  process.env.OVERLORD_BACKEND_URL = 'http://host.docker.internal:4310';
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath);
    assert.equal(resolveBackendUrl(config), 'http://host.docker.internal:4310');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('resolveBackendUrl adds http:// when OVERLORD_BACKEND_URL omits the scheme', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `backend_url = "http://127.0.0.1:4310"\n`);

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  process.env.OVERLORD_BACKEND_URL = 'host.docker.internal:4310';
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath);
    assert.equal(resolveBackendUrl(config), 'http://host.docker.internal:4310');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('a production .env.prod-backfilled OVERLORD_BACKEND_URL does not beat overlord.toml', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `backend_url = "https://overlord.example.com"\n`);
  writeFileSync(path.join(dir, '.env.prod'), 'OVERLORD_BACKEND_URL=http://127.0.0.1:9999\n');

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  delete process.env.OVERLORD_BACKEND_URL;
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath, 'production');
    assert.equal(resolveBackendUrl(config, 'production'), 'https://overlord.example.com');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('a development .env.local-backfilled OVERLORD_BACKEND_URL_DEV does not beat overlord.toml', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  // An explicit per-instance `overlord.toml` (e.g. from `ovld config set`) outranks
  // the `.env.local` dev default; only a deliberate shell export of the dev var would
  // beat it. The dev value must also never leak into the production variable.
  writeFileSync(configPath, `backend_url = "https://overlord.example.com"\n`);
  writeFileSync(path.join(dir, '.env.local'), 'OVERLORD_BACKEND_URL_DEV=http://127.0.0.1:9999\n');

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  const previousDevBackendUrl = process.env.OVERLORD_BACKEND_URL_DEV;
  delete process.env.OVERLORD_BACKEND_URL;
  delete process.env.OVERLORD_BACKEND_URL_DEV;
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath, 'development');
    assert.equal(resolveBackendUrl(config, 'development'), 'https://overlord.example.com');
    // The production variable is never set as a side effect.
    assert.equal(process.env.OVERLORD_BACKEND_URL, undefined);
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    if (previousDevBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL_DEV;
    else process.env.OVERLORD_BACKEND_URL_DEV = previousDevBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('an explicit runtime OVERLORD_BACKEND_URL_DEV beats overlord.toml in development', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `backend_url = "http://127.0.0.1:4310"\n`);

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  const previousDevBackendUrl = process.env.OVERLORD_BACKEND_URL_DEV;
  delete process.env.OVERLORD_BACKEND_URL;
  process.env.OVERLORD_BACKEND_URL_DEV = 'http://127.0.0.1:4320';
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath, 'development');
    assert.equal(resolveBackendUrl(config, 'development'), 'http://127.0.0.1:4320');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    if (previousDevBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL_DEV;
    else process.env.OVERLORD_BACKEND_URL_DEV = previousDevBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('a .env.local-backfilled OVERLORD_BACKEND_URL_DEV is used when overlord.toml has no backend_url', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'overlord.toml');
  writeFileSync(configPath, `instance_name = "No backend override"\n`);
  writeFileSync(path.join(dir, '.env.local'), 'OVERLORD_BACKEND_URL_DEV=http://127.0.0.1:4320\n');

  const previousBackendUrl = process.env.OVERLORD_BACKEND_URL;
  const previousDevBackendUrl = process.env.OVERLORD_BACKEND_URL_DEV;
  delete process.env.OVERLORD_BACKEND_URL;
  delete process.env.OVERLORD_BACKEND_URL_DEV;
  resetExplicitRuntimeEnvForTests();
  try {
    const config = loadConfig(configPath);
    assert.equal(resolveBackendUrl(config), 'http://127.0.0.1:4320');
  } finally {
    if (previousBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL;
    else process.env.OVERLORD_BACKEND_URL = previousBackendUrl;
    if (previousDevBackendUrl === undefined) delete process.env.OVERLORD_BACKEND_URL_DEV;
    else process.env.OVERLORD_BACKEND_URL_DEV = previousDevBackendUrl;
    resetExplicitRuntimeEnvForTests();
  }
});

test('writeConfig no longer writes terminal launcher keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const configPath = path.join(dir, 'config.toml');
  const previous = process.env.OVERLORD_ALLOW_CONFIG_WRITE;
  process.env.OVERLORD_ALLOW_CONFIG_WRITE = '1';
  try {
    writeConfig({ targetPath: configPath, config: { instanceName: 'Local Overlord' } });
    const raw = readFileSync(configPath, 'utf8');
    assert.ok(!raw.includes('terminal_launcher'));
  } finally {
    if (previous === undefined) delete process.env.OVERLORD_ALLOW_CONFIG_WRITE;
    else process.env.OVERLORD_ALLOW_CONFIG_WRITE = previous;
  }
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

test('writeConfig refuses to persist overlord.toml from inside a container', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const targetPath = path.join(dir, 'overlord.toml');

  const previousInPod = process.env.OVERLORD_IN_POD;
  const previousAllow = process.env.OVERLORD_ALLOW_CONFIG_WRITE;
  process.env.OVERLORD_IN_POD = '1';
  delete process.env.OVERLORD_ALLOW_CONFIG_WRITE;
  try {
    assert.throws(
      () => writeConfig({ targetPath, config: { backendUrl: 'http://host.docker.internal:4310' } }),
      /Refusing to write overlord\.toml from inside a container/
    );
  } finally {
    if (previousInPod === undefined) delete process.env.OVERLORD_IN_POD;
    else process.env.OVERLORD_IN_POD = previousInPod;
    if (previousAllow === undefined) delete process.env.OVERLORD_ALLOW_CONFIG_WRITE;
    else process.env.OVERLORD_ALLOW_CONFIG_WRITE = previousAllow;
  }
});

test('OVERLORD_ALLOW_CONFIG_WRITE overrides the container write guard', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'overlord-config-'));
  const targetPath = path.join(dir, 'overlord.toml');

  const previousInPod = process.env.OVERLORD_IN_POD;
  const previousAllow = process.env.OVERLORD_ALLOW_CONFIG_WRITE;
  process.env.OVERLORD_IN_POD = '1';
  process.env.OVERLORD_ALLOW_CONFIG_WRITE = '1';
  try {
    writeConfig({ targetPath, config: { backendUrl: DEFAULT_LOCAL_BACKEND_URL } });
    assert.match(readFileSync(targetPath, 'utf8'), /backend_url = "http:\/\/127\.0\.0\.1:4310"/);
  } finally {
    if (previousInPod === undefined) delete process.env.OVERLORD_IN_POD;
    else process.env.OVERLORD_IN_POD = previousInPod;
    if (previousAllow === undefined) delete process.env.OVERLORD_ALLOW_CONFIG_WRITE;
    else process.env.OVERLORD_ALLOW_CONFIG_WRITE = previousAllow;
  }
});
