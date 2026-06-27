#!/usr/bin/env node
/**
 * Keeps agent connector semver versions in sync across plugin manifests and MCP shims.
 *
 * Source of truth: connectors/VERSION
 *
 * Usage:
 *   node scripts/sync-connector-versions.mjs --sync
 *   node scripts/sync-connector-versions.mjs --bump patch
 *   node scripts/sync-connector-versions.mjs --set 0.2.4
 *   node scripts/sync-connector-versions.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const versionFile = resolve(root, 'connectors/VERSION');

const PLUGIN_JSON_TARGETS = [
  'connectors/adapters/claude/.claude-plugin/plugin.json',
  'connectors/adapters/codex/.codex-plugin/plugin.json',
  'connectors/adapters/cursor/.cursor-plugin/plugin.json'
];

const MCP_SERVER_INFO_TARGETS = [
  {
    path: 'connectors/adapters/codex/scripts/overlord-mcp.mjs',
    serverName: 'overlord-codex'
  },
  {
    path: 'connectors/adapters/cursor/scripts/overlord-mcp.mjs',
    serverName: 'overlord-cursor'
  }
];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function readCanonicalVersion() {
  const raw = readFileSync(versionFile, 'utf8').trim();
  if (!SEMVER_PATTERN.test(raw)) {
    throw new Error(`Invalid semver in ${versionFile}: "${raw}"`);
  }
  return raw;
}

function writeCanonicalVersion(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid semver: "${version}"`);
  }
  writeFileSync(versionFile, `${version}\n`);
}

function bumpSemver({ version, part }) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid semver: "${version}"`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (part === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor += 1;
    patch = 0;
  } else if (part === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unknown bump part: "${part}"`);
  }

  return `${major}.${minor}.${patch}`;
}

function readPluginJsonVersion(relPath) {
  const absPath = resolve(root, relPath);
  const plugin = JSON.parse(readFileSync(absPath, 'utf8'));
  return plugin.version;
}

function updatePluginJson({ relPath, version }) {
  const absPath = resolve(root, relPath);
  const plugin = JSON.parse(readFileSync(absPath, 'utf8'));
  const oldVersion = plugin.version;
  plugin.version = version;
  writeFileSync(absPath, `${JSON.stringify(plugin, null, 2)}\n`);
  return { relPath, oldVersion, newVersion: version };
}

function readMcpServerInfoVersion({ relPath, serverName }) {
  const absPath = resolve(root, relPath);
  const source = readFileSync(absPath, 'utf8');
  const pattern = new RegExp(
    `serverInfo:\\s*\\{\\s*name:\\s*'${serverName}',\\s*version:\\s*'([^']+)'\\s*\\}`
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find serverInfo version for ${serverName} in ${relPath}`);
  }
  return match[1];
}

function updateMcpServerInfo({ relPath, serverName, version }) {
  const absPath = resolve(root, relPath);
  const source = readFileSync(absPath, 'utf8');
  const pattern = new RegExp(
    `serverInfo:\\s*\\{\\s*name:\\s*'${serverName}',\\s*version:\\s*'[^']+'\\s*\\}`
  );
  const replacement = `serverInfo: { name: '${serverName}', version: '${version}' }`;
  if (!pattern.test(source)) {
    throw new Error(`Could not find serverInfo block for ${serverName} in ${relPath}`);
  }
  const oldVersion = readMcpServerInfoVersion({ relPath, serverName });
  writeFileSync(absPath, source.replace(pattern, replacement));
  return { relPath, oldVersion, newVersion: version };
}

function collectCurrentVersions() {
  const pluginVersions = Object.fromEntries(
    PLUGIN_JSON_TARGETS.map(relPath => [relPath, readPluginJsonVersion(relPath)])
  );
  const mcpVersions = Object.fromEntries(
    MCP_SERVER_INFO_TARGETS.map(target => [
      target.path,
      readMcpServerInfoVersion({ relPath: target.path, serverName: target.serverName })
    ])
  );
  return { pluginVersions, mcpVersions };
}

function syncAllTargets(version) {
  const changes = [];

  for (const relPath of PLUGIN_JSON_TARGETS) {
    const result = updatePluginJson({ relPath, version });
    if (result.oldVersion !== result.newVersion) {
      changes.push(result);
    }
  }

  for (const target of MCP_SERVER_INFO_TARGETS) {
    const result = updateMcpServerInfo({
      relPath: target.path,
      serverName: target.serverName,
      version
    });
    if (result.oldVersion !== result.newVersion) {
      changes.push(result);
    }
  }

  return changes;
}

function printUsage() {
  console.log(`Usage:
  node scripts/sync-connector-versions.mjs --sync
  node scripts/sync-connector-versions.mjs --bump <patch|minor|major>
  node scripts/sync-connector-versions.mjs --set <x.y.z>
  node scripts/sync-connector-versions.mjs --check`);
}

function parseArgs(argv) {
  const options = {
    sync: false,
    check: false,
    bump: null,
    set: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sync') {
      options.sync = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--bump') {
      options.bump = argv[index + 1];
      if (!options.bump) {
        throw new Error('Missing value for --bump');
      }
      index += 1;
      continue;
    }
    if (arg === '--set') {
      options.set = argv[index + 1];
      if (!options.set) {
        throw new Error('Missing value for --set');
      }
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const actionCount = [options.sync, options.check, options.bump, options.set].filter(Boolean).length;

  if (actionCount === 0) {
    options.sync = true;
  }
  if (actionCount > 1) {
    throw new Error('Use only one of --sync, --check, --bump, or --set');
  }

  if (options.check) {
    const canonicalVersion = readCanonicalVersion();
    const { pluginVersions, mcpVersions } = collectCurrentVersions();
    const mismatches = [];

    for (const [relPath, version] of Object.entries(pluginVersions)) {
      if (version !== canonicalVersion) {
        mismatches.push(`${relPath}: ${version} (expected ${canonicalVersion})`);
      }
    }
    for (const [relPath, version] of Object.entries(mcpVersions)) {
      if (version !== canonicalVersion) {
        mismatches.push(`${relPath}: ${version} (expected ${canonicalVersion})`);
      }
    }

    if (mismatches.length > 0) {
      console.error('Connector versions are out of sync:');
      for (const mismatch of mismatches) {
        console.error(`  - ${mismatch}`);
      }
      console.error(`\nRun: yarn connectors:version:sync`);
      process.exit(1);
    }

    console.log(`Connector versions are in sync at ${canonicalVersion}.`);
    return;
  }

  let version = readCanonicalVersion();

  if (options.bump) {
    const nextVersion = bumpSemver({ version, part: options.bump });
    writeCanonicalVersion(nextVersion);
    version = nextVersion;
    console.log(`Bumped connectors/VERSION → ${version}`);
  } else if (options.set) {
    writeCanonicalVersion(options.set);
    version = options.set;
    console.log(`Set connectors/VERSION → ${version}`);
  }

  const changes = syncAllTargets(version);
  if (changes.length === 0) {
    console.log(`All connector version targets already at ${version}.`);
    return;
  }

  console.log(`Synced connector versions to ${version}:`);
  for (const change of changes) {
    console.log(`  ${change.relPath}: ${change.oldVersion} → ${change.newVersion}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  printUsage();
  process.exit(1);
}
