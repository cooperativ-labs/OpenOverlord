import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** Native agent binary names by connector key, for PATH detection. */
const AGENT_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor'
};

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
    stateFiles.push({ path: relativePath, sha256: sha256(contents) });
  }

  if (!dryRun) {
    const state: InstallState = {
      agentKey,
      agentIdentifier: manifest.connector.agentIdentifier,
      contractVersion: manifest.contractVersion,
      installPath,
      installedAt: new Date().toISOString(),
      files: stateFiles
    };
    const statePath = installStatePath(agentKey, resolvedHome);
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  const binaryName = AGENT_BINARIES[agentKey] ?? manifest.connector.agentIdentifier;
  const binaryFound = findOnPath(binaryName);
  if (!binaryFound) {
    warnings.push(
      `Agent binary "${binaryName}" not found on PATH. The connector is installed; ` +
        `install ${binaryName} to launch this agent.`
    );
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
  const binaryName = AGENT_BINARIES[agentKey] ?? manifest.connector.agentIdentifier;
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
    const source = path.join(connectorDir(agentKey), relativePath);
    const expected = existsSync(source) ? sha256(readFileSync(source)) : recorded?.sha256;
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
