import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAgentBinary } from './agent-binaries.js';
import { resolveRepoPath } from './config.js';
import { CliError } from './errors.js';

/**
 * Connector setup/doctor for the Connector Layer (see CONTRACT.md → Connector
 * Layer). `ovld setup <agent>` materializes a connector adapter's declared
 * `managedFiles` into the agent's native plugin install path and records a
 * local install manifest so `ovld doctor` can detect stale, missing, or
 * modified files. Installs are idempotent and never touch files outside the
 * connector's own install path.
 */

export type ConnectorManifest = {
  contractVersion: string;
  componentType: string;
  componentKey: string;
  label?: string;
  description?: string;
  connector: {
    agentIdentifier: string;
    capabilities: string[];
    hookTypes: string[];
    installPath: string;
    managedFiles: string[];
  };
};

export type ManagedFileResult = {
  path: string;
  action: 'written' | 'unchanged' | 'would-write';
  executable: boolean;
};

export type SetupResult = {
  agentKey: string;
  agentIdentifier: string;
  installPath: string;
  contractVersion: string;
  files: ManagedFileResult[];
  binaryFound: boolean;
  binaryName: string;
  dryRun: boolean;
  warnings: string[];
};

export type InstallState = {
  agentKey: string;
  agentIdentifier: string;
  contractVersion: string;
  installPath: string;
  installedAt: string;
  files: Array<{ path: string; sha256: string }>;
};

export type ConnectorReport = {
  agentKey: string;
  installed: boolean;
  healthy: boolean;
  installPath: string;
  binaryName: string;
  binaryFound: boolean;
  staleContractVersion: boolean;
  problems: string[];
};

const CURSOR_HOOK_COMMAND = 'plugins/local/overlord/hooks/overlord-user-prompt-submit.sh';
const CURSOR_PROTOCOL_PERMISSION = 'Shell(ovld protocol:*)';
const CODEX_PLUGIN_KEY = 'overlord@overlord-local';
const CODEX_RULES_START = '# overlord:permissions:start';
const CODEX_RULES_END = '# overlord:permissions:end';
const CLAUDE_MARKETPLACE_NAME = 'overlord-local';
const CLAUDE_PLUGIN_KEY = `overlord@${CLAUDE_MARKETPLACE_NAME}`;

/**
 * Locate the connector adapter source tree. The connectors directory is not
 * bundled into the published CLI package, so resolve it in priority order:
 * an explicit `OVERLORD_CONNECTORS_DIR` override, the nearest `connectors/
 * adapters` walking up from the working directory (covers a global `ovld` run
 * inside a repo checkout), then the package-relative fallback.
 */
function connectorsRoot(): string {
  const override = process.env.OVERLORD_CONNECTORS_DIR;
  if (override) return override;

  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, 'connectors', 'adapters');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return resolveRepoPath('connectors/adapters');
}

function connectorDir(agentKey: string): string {
  return path.join(connectorsRoot(), agentKey);
}

function manifestPath(agentKey: string): string {
  return path.join(connectorDir(agentKey), 'conformance-manifest.yaml');
}

/** List connector adapter keys that ship a conformance manifest on disk. */
export function listAvailableConnectors(): string[] {
  const root = connectorsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(manifestPath(name)))
    .sort();
}

/**
 * Minimal YAML reader for connector conformance manifests. Supports the
 * constrained subset these manifests use: top-level scalars, one nested map
 * (`connector:`), and scalar sequences. It is intentionally not a general YAML
 * parser — manifests are controlled, contract-governed artifacts.
 */
export function parseConnectorManifestYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  type Frame = { indent: number; container: Record<string, unknown> | unknown[] };
  const stack: Frame[] = [{ indent: 0, container: root }];
  let pending: { parent: Record<string, unknown>; key: string; indent: number } | null = null;

  const parseScalar = (raw: string): string => {
    const value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (pending) {
      if (indent > pending.indent) {
        const container: Record<string, unknown> | unknown[] = trimmed.startsWith('- ') ? [] : {};
        pending.parent[pending.key] = container;
        stack.push({ indent, container });
        pending = null;
      } else {
        pending.parent[pending.key] = '';
        pending = null;
      }
    }

    while (stack.length > 1 && stack[stack.length - 1]!.indent > indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1]!;

    if (trimmed.startsWith('- ')) {
      if (Array.isArray(frame.container)) {
        frame.container.push(parseScalar(trimmed.slice(2)));
      }
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon < 0 || Array.isArray(frame.container)) continue;
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest === '') {
      pending = { parent: frame.container, key, indent };
    } else {
      frame.container[key] = parseScalar(rest);
    }
  }

  return root;
}

export function readConnectorManifest(agentKey: string): ConnectorManifest {
  const file = manifestPath(agentKey);
  if (!existsSync(file)) {
    throw new CliError({
      message:
        `Unknown connector: ${agentKey}\n` +
        `Available connectors: ${listAvailableConnectors().join(', ') || '(none)'}`
    });
  }
  const parsed = parseConnectorManifestYaml(readFileSync(file, 'utf8'));
  const connector = (parsed.connector ?? {}) as Record<string, unknown>;
  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(item => String(item)) : [];

  const installPath = String(connector.installPath ?? '');
  const managedFiles = asList(connector.managedFiles);
  if (!installPath || managedFiles.length === 0) {
    throw new CliError({
      message: `Connector manifest for ${agentKey} is missing installPath or managedFiles.`
    });
  }

  return {
    contractVersion: String(parsed.contractVersion ?? ''),
    componentType: String(parsed.componentType ?? ''),
    componentKey: String(parsed.componentKey ?? agentKey),
    label: parsed.label ? String(parsed.label) : undefined,
    description: parsed.description ? String(parsed.description) : undefined,
    connector: {
      agentIdentifier: String(connector.agentIdentifier ?? agentKey),
      capabilities: asList(connector.capabilities),
      hookTypes: asList(connector.hookTypes),
      installPath,
      managedFiles
    }
  };
}

export function resolveHome(home?: string): string {
  return home ?? process.env.OVERLORD_HOME ?? os.homedir();
}

/** Expand a leading `~` in a manifest install path against the resolved home. */
export function expandInstallPath(installPath: string, home: string): string {
  if (installPath === '~') return home;
  if (installPath.startsWith('~/')) return path.join(home, installPath.slice(2));
  return installPath;
}

function installStatePath(agentKey: string, home: string): string {
  return path.join(home, '.ovld', 'connectors', `${agentKey}.json`);
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function findOnPath(command: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (statSync(candidate).isFile()) return true;
    } catch {
      // not here; keep looking
    }
  }
  return false;
}

function isExecutableManaged(relativePath: string): boolean {
  return relativePath.endsWith('.sh');
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Merge Cursor harness hooks and permission rules without clobbering user settings. */
function configureCursorHarness({
  home,
  dryRun = false
}: {
  home: string;
  dryRun?: boolean;
}): string[] {
  const warnings: string[] = [];
  const cursorDir = path.join(home, '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');
  const settingsPath = path.join(cursorDir, 'settings.json');

  const hooks =
    readJsonObject(hooksPath) ??
    ({
      version: 1,
      hooks: {}
    } as Record<string, unknown>);
  const hookRoot = hooks.hooks;
  const hookEntries =
    hookRoot && typeof hookRoot === 'object' && !Array.isArray(hookRoot)
      ? (hookRoot as Record<string, unknown>)
      : {};
  const beforeSubmit = Array.isArray(hookEntries.beforeSubmitPrompt)
    ? [...(hookEntries.beforeSubmitPrompt as unknown[])]
    : [];
  const alreadyInstalled = beforeSubmit.some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const command = (entry as Record<string, unknown>).command;
    return typeof command === 'string' && command.includes('overlord-user-prompt-submit');
  });
  if (!alreadyInstalled) {
    beforeSubmit.push({ command: CURSOR_HOOK_COMMAND });
    hookEntries.beforeSubmitPrompt = beforeSubmit;
    hooks.hooks = hookEntries;
    if (dryRun) {
      warnings.push(`Would merge beforeSubmitPrompt hook into ${hooksPath}.`);
    } else {
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    }
  }

  const settings = readJsonObject(settingsPath) ?? {};
  const permissionsRoot = settings.permissions;
  const permissions =
    permissionsRoot && typeof permissionsRoot === 'object' && !Array.isArray(permissionsRoot)
      ? (permissionsRoot as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  if (!allow.includes(CURSOR_PROTOCOL_PERMISSION)) {
    allow.push(CURSOR_PROTOCOL_PERMISSION);
    permissions.allow = allow;
    settings.permissions = permissions;
    if (dryRun) {
      warnings.push(`Would add ${CURSOR_PROTOCOL_PERMISSION} to ${settingsPath}.`);
    } else {
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }

  return warnings;
}

function mergeCodexRules(existingContent: string): string {
  const managedBlock = [
    CODEX_RULES_START,
    'prefix_rule(',
    '  pattern = ["npx", "overlord", "protocol"],',
    '  decision = "allow",',
    '  justification = "Allow all Overlord protocol commands without prompts.",',
    ')',
    '',
    'prefix_rule(',
    '  pattern = ["ovld", "protocol"],',
    '  decision = "allow",',
    '  justification = "Allow all Overlord protocol commands without prompts.",',
    ')',
    CODEX_RULES_END
  ].join('\n');

  const startIndex = existingContent.indexOf(CODEX_RULES_START);
  const endIndex = existingContent.indexOf(CODEX_RULES_END);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex).trimEnd();
    const after = existingContent.slice(endIndex + CODEX_RULES_END.length).trimStart();
    if (!before && !after) return `${managedBlock}\n`;
    if (!before) return `${managedBlock}\n\n${after}`;
    if (!after) return `${before}\n\n${managedBlock}\n`;
    return `${before}\n\n${managedBlock}\n\n${after}`;
  }

  const trimmed = existingContent.trimEnd();
  if (!trimmed) return `${managedBlock}\n`;
  return `${trimmed}\n\n${managedBlock}\n`;
}

function rewriteCodexHookCommands({
  hooks,
  eventName,
  targetCommand
}: {
  hooks: Record<string, unknown>;
  eventName: string;
  targetCommand: string;
}): void {
  const hookRoot = hooks.hooks;
  if (!hookRoot || typeof hookRoot !== 'object' || Array.isArray(hookRoot)) return;
  const groups = (hookRoot as Record<string, unknown>)[eventName];
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const entries = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(entries)) continue;
    for (const hook of entries) {
      if (
        hook &&
        typeof hook === 'object' &&
        (hook as Record<string, unknown>).type === 'command'
      ) {
        (hook as Record<string, unknown>).command = targetCommand;
      }
    }
  }
}

/** Merge Codex marketplace, rules, hook paths, and plugin enablement without clobbering user settings. */
function configureCodexHarness({
  home,
  installPath,
  dryRun = false
}: {
  home: string;
  installPath: string;
  dryRun?: boolean;
}): string[] {
  const warnings: string[] = [];
  const marketplacePath = path.join(home, '.agents', 'plugins', 'marketplace.json');
  const rulesPath = path.join(home, '.codex', 'rules', 'default.rules');
  const legacyAgentsPath = path.join(home, '.codex', 'AGENTS.md');
  const hooksPath = path.join(installPath, '.codex-plugin', 'hooks.json');
  const userPromptHook = path.join(installPath, 'scripts', 'user-prompt-submit-hook.sh');
  const permissionHook = path.join(installPath, 'scripts', 'permission-hook.sh');

  const currentMarketplace = readJsonObject(marketplacePath) ?? {
    name: 'overlord-local',
    interface: { displayName: 'Overlord Local Plugins' },
    plugins: []
  };
  const nextPlugins = Array.isArray(currentMarketplace.plugins)
    ? [...(currentMarketplace.plugins as unknown[])]
    : [];
  const entry = {
    name: 'overlord',
    source: { source: 'local', path: './.codex/plugins/overlord' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity'
  };
  const existingIndex = nextPlugins.findIndex(
    plugin =>
      plugin &&
      typeof plugin === 'object' &&
      (plugin as Record<string, unknown>).name === 'overlord'
  );
  if (existingIndex === -1) nextPlugins.push(entry);
  else nextPlugins[existingIndex] = entry;

  if (dryRun) {
    warnings.push(`Would update Codex marketplace at ${marketplacePath}.`);
    warnings.push(`Would merge protocol permission rules into ${rulesPath}.`);
    warnings.push(`Would rewrite Codex hook commands in ${hooksPath}.`);
    if (existsSync(legacyAgentsPath)) {
      warnings.push(`Would remove legacy Codex bundle at ${legacyAgentsPath}.`);
    }
    warnings.push(
      `Would run \`codex plugin add ${CODEX_PLUGIN_KEY}\` when the Codex CLI is available.`
    );
    return warnings;
  }

  mkdirSync(path.dirname(marketplacePath), { recursive: true });
  writeFileSync(
    marketplacePath,
    `${JSON.stringify(
      {
        name: currentMarketplace.name ?? 'overlord-local',
        interface: {
          displayName:
            (currentMarketplace.interface as Record<string, unknown> | undefined)?.displayName ??
            'Overlord Local Plugins'
        },
        plugins: nextPlugins
      },
      null,
      2
    )}\n`
  );

  const existingRules = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
  mkdirSync(path.dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, mergeCodexRules(existingRules));

  const hooks = readJsonObject(hooksPath);
  if (hooks) {
    rewriteCodexHookCommands({
      hooks,
      eventName: 'PermissionRequest',
      targetCommand: permissionHook
    });
    rewriteCodexHookCommands({
      hooks,
      eventName: 'UserPromptSubmit',
      targetCommand: userPromptHook
    });
    writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  } else {
    warnings.push(`Codex hook manifest missing or invalid at ${hooksPath}.`);
  }

  if (existsSync(legacyAgentsPath)) {
    rmSync(legacyAgentsPath, { force: true });
  }

  const codexAdd = spawnSync('codex', ['plugin', 'add', CODEX_PLUGIN_KEY], {
    encoding: 'utf8',
    timeout: 30_000
  });
  if (codexAdd.error && (codexAdd.error as NodeJS.ErrnoException).code === 'ENOENT') {
    warnings.push(
      `Codex CLI not found on PATH — wrote the marketplace but could not install the plugin. ` +
        `Run \`codex plugin add ${CODEX_PLUGIN_KEY}\` once Codex is installed.`
    );
  } else if (codexAdd.status !== 0) {
    const output = `${codexAdd.stdout ?? ''}${codexAdd.stderr ?? ''}`;
    if (/already/i.test(output)) {
      return warnings;
    }
    warnings.push(
      `Could not install the Codex plugin via the Codex CLI. Re-run \`ovld setup codex\` to retry.`
    );
  }

  return warnings;
}

/**
 * Register the Overlord plugin with Claude Code. Unlike Cursor and Codex, Claude
 * Code never auto-discovers a plugin merely dropped into `~/.claude/plugins`; it
 * only loads plugins published through a registered marketplace. So we build a
 * local marketplace whose single plugin entry points at the freshly-installed
 * plugin tree (`installPath`), then drive the Claude CLI to add the marketplace
 * and install + enable the plugin. The CLI writes the same files (`config dir`'s
 * `known_marketplaces.json`, `installed_plugins.json`, and `enabledPlugins` in
 * `settings.json`) it would on an interactive `/plugin install`, so the result
 * is identical to a hand-installed plugin.
 *
 * `installPath` ends in `plugins/overlord`; its grandparent is the marketplace
 * root that holds `.claude-plugin/marketplace.json`. The plugin `source` must be
 * a path relative to that root — Claude rejects absolute sources.
 */
function configureClaudeHarness({
  home,
  installPath,
  dryRun = false
}: {
  home: string;
  installPath: string;
  dryRun?: boolean;
}): string[] {
  const warnings: string[] = [];
  const marketplaceRoot = path.dirname(path.dirname(installPath));
  const marketplacePath = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const relativeSource = `./${path.relative(marketplaceRoot, installPath).split(path.sep).join('/')}`;
  const configDir = path.join(home, '.claude');

  const marketplace = {
    name: CLAUDE_MARKETPLACE_NAME,
    owner: { name: 'Cooperativ' },
    metadata: { description: 'Overlord local plugin marketplace.' },
    plugins: [
      {
        name: 'overlord',
        source: relativeSource,
        description: 'Overlord ticket protocol workflow for Claude Code.'
      }
    ]
  };

  if (dryRun) {
    warnings.push(`Would write Claude marketplace manifest at ${marketplacePath}.`);
    warnings.push(
      `Would run \`claude plugin marketplace add\` and \`claude plugin install ${CLAUDE_PLUGIN_KEY}\` ` +
        `when the Claude CLI is available.`
    );
    return warnings;
  }

  mkdirSync(path.dirname(marketplacePath), { recursive: true });
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  const runClaude = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync('claude', args, {
      encoding: 'utf8',
      timeout: 60_000,
      // Pin the CLI to the same home we installed into so the marketplace and
      // plugin land in this home's config dir rather than the caller's real one.
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }
    });

  const add = runClaude(['plugin', 'marketplace', 'add', marketplaceRoot]);
  if (add.error && (add.error as NodeJS.ErrnoException).code === 'ENOENT') {
    warnings.push(
      `Claude CLI not found on PATH — wrote the marketplace but could not install the plugin. ` +
        `Run \`claude plugin marketplace add ${marketplaceRoot}\` then ` +
        `\`claude plugin install ${CLAUDE_PLUGIN_KEY}\` once Claude Code is installed.`
    );
    return warnings;
  }
  // `marketplace add` fails when the marketplace already exists; refresh it from
  // source instead so re-running `ovld setup claude` picks up plugin changes.
  if (add.status !== 0) {
    const output = `${add.stdout ?? ''}${add.stderr ?? ''}`;
    if (/already|exists/i.test(output)) {
      runClaude(['plugin', 'marketplace', 'update', CLAUDE_MARKETPLACE_NAME]);
    } else {
      warnings.push(
        `Could not register the Claude marketplace. Re-run \`ovld setup claude\` to retry.`
      );
      return warnings;
    }
  }

  const install = runClaude(['plugin', 'install', CLAUDE_PLUGIN_KEY, '--scope', 'user']);
  if (install.status !== 0) {
    const output = `${install.stdout ?? ''}${install.stderr ?? ''}`;
    if (/already/i.test(output)) {
      // Already installed — refresh the cached copy so file edits take effect.
      runClaude(['plugin', 'update', CLAUDE_PLUGIN_KEY]);
    } else {
      warnings.push(
        `Could not install the Claude plugin via the Claude CLI. Re-run \`ovld setup claude\` to retry.`
      );
    }
  }

  return warnings;
}

export function setupConnector({
  agentKey,
  home,
  dryRun = false
}: {
  agentKey: string;
  home?: string;
  dryRun?: boolean;
}): SetupResult {
  const manifest = readConnectorManifest(agentKey);
  const resolvedHome = resolveHome(home);
  const installPath = expandInstallPath(manifest.connector.installPath, resolvedHome);
  const sourceDir = connectorDir(agentKey);
  const warnings: string[] = [];

  const files: ManagedFileResult[] = [];
  const stateFiles: Array<{ path: string; sha256: string }> = [];

  for (const relativePath of manifest.connector.managedFiles) {
    const source = path.join(sourceDir, relativePath);
    if (!existsSync(source)) {
      warnings.push(`Declared managed file missing from connector source: ${relativePath}`);
      continue;
    }
    const contents = readFileSync(source);
    const target = path.join(installPath, relativePath);
    const executable = isExecutableManaged(relativePath);

    const targetExists = existsSync(target);
    const unchanged = targetExists && sha256(readFileSync(target)) === sha256(contents);

    if (dryRun) {
      files.push({
        path: relativePath,
        action: unchanged ? 'unchanged' : 'would-write',
        executable
      });
    } else {
      if (!unchanged) {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      if (executable) {
        chmodSync(target, 0o755);
      }
      files.push({ path: relativePath, action: unchanged ? 'unchanged' : 'written', executable });
    }
    if (!dryRun) {
      stateFiles.push({ path: relativePath, sha256: sha256(contents) });
    }
  }

  const binaryName = resolveAgentBinary(agentKey);
  const binaryFound = findOnPath(binaryName);
  if (!binaryFound) {
    warnings.push(
      `Agent binary "${binaryName}" not found on PATH. The connector is installed; ` +
        `install ${binaryName} to launch this agent.`
    );
  }

  if (agentKey === 'cursor') {
    warnings.push(...configureCursorHarness({ home: resolvedHome, dryRun }));
  }

  if (agentKey === 'codex') {
    warnings.push(...configureCodexHarness({ home: resolvedHome, installPath, dryRun }));
  }

  if (agentKey === 'claude') {
    warnings.push(...configureClaudeHarness({ home: resolvedHome, installPath, dryRun }));
  }

  if (!dryRun) {
    const installedStateFiles = manifest.connector.managedFiles
      .map(relativePath => {
        const target = path.join(installPath, relativePath);
        if (!existsSync(target)) return null;
        return { path: relativePath, sha256: sha256(readFileSync(target)) };
      })
      .filter((entry): entry is { path: string; sha256: string } => entry !== null);

    const state: InstallState = {
      agentKey,
      agentIdentifier: manifest.connector.agentIdentifier,
      contractVersion: manifest.contractVersion,
      installPath,
      installedAt: new Date().toISOString(),
      files: installedStateFiles
    };
    const statePath = installStatePath(agentKey, resolvedHome);
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  return {
    agentKey,
    agentIdentifier: manifest.connector.agentIdentifier,
    installPath,
    contractVersion: manifest.contractVersion,
    files,
    binaryFound,
    binaryName,
    dryRun,
    warnings
  };
}

export function setupAllConnectors({
  home,
  dryRun = false
}: {
  home?: string;
  dryRun?: boolean;
}): SetupResult[] {
  const agents = listAvailableConnectors();
  if (agents.length === 0) {
    throw new CliError({ message: 'No connector adapters found under connectors/adapters.' });
  }
  return agents.map(agentKey => setupConnector({ agentKey, home, dryRun }));
}

function readInstallState(agentKey: string, home: string): InstallState | null {
  const statePath = installStatePath(agentKey, home);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as InstallState;
  } catch {
    return null;
  }
}

/** Inspect one connector's local install for `ovld doctor`. */
export function inspectConnector({
  agentKey,
  home
}: {
  agentKey: string;
  home?: string;
}): ConnectorReport {
  const resolvedHome = resolveHome(home);
  const manifest = readConnectorManifest(agentKey);
  const binaryName = resolveAgentBinary(agentKey);
  const binaryFound = findOnPath(binaryName);
  const state = readInstallState(agentKey, resolvedHome);

  if (!state) {
    return {
      agentKey,
      installed: false,
      healthy: false,
      installPath: expandInstallPath(manifest.connector.installPath, resolvedHome),
      binaryName,
      binaryFound,
      staleContractVersion: false,
      problems: []
    };
  }

  const problems: string[] = [];
  const staleContractVersion = state.contractVersion !== manifest.contractVersion;
  if (staleContractVersion) {
    problems.push(
      `Installed against contract ${state.contractVersion}; connector now declares ` +
        `${manifest.contractVersion}. Re-run \`ovld setup ${agentKey}\`.`
    );
  }

  const declared = new Set(manifest.connector.managedFiles);
  for (const relativePath of manifest.connector.managedFiles) {
    const target = path.join(state.installPath, relativePath);
    if (!existsSync(target)) {
      problems.push(`Missing managed file: ${relativePath}`);
      continue;
    }
    const recorded = state.files.find(file => file.path === relativePath);
    const actual = sha256(readFileSync(target));
    const expected = recorded?.sha256;
    if (expected && actual !== expected) {
      problems.push(`Modified or stale managed file: ${relativePath}`);
    }
  }
  for (const recorded of state.files) {
    if (!declared.has(recorded.path)) {
      problems.push(`Undeclared managed file recorded in install state: ${recorded.path}`);
    }
  }

  return {
    agentKey,
    installed: true,
    healthy: problems.length === 0,
    installPath: state.installPath,
    binaryName,
    binaryFound,
    staleContractVersion,
    problems
  };
}
