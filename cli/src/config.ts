import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

import { parseAgentCatalogFromToml } from './agent-catalog.ts';
import type { CatalogAgent } from './agent-catalog-defaults.ts';

export const DEFAULT_LOCAL_BACKEND_DIR = '~/.ovld';
export const DEFAULT_LOCAL_BACKEND_DATABASE_PATH = '~/.ovld/Overlord.sqlite';
export const DEFAULT_LOCAL_BACKEND_URL = 'http://127.0.0.1:4310';

export type BackendMode = 'local' | 'cloud';

export type OverlordConfig = {
  instanceName: string;
  backendMode: BackendMode;
  backendUrl: string | null;
  /**
   * Developer override for the local SQLite location. Relative paths resolve
   * against the `overlord.toml` directory; absolute paths are used as-is.
   * `null` means use the per-user global default (`~/.ovld/Overlord.sqlite`).
   */
  databasePath: string | null;
  /**
   * Admin-configured cloud database connection string (e.g. a PostgreSQL URL)
   * for running Overlord against a hosted database. `null` means use the local
   * SQLite database at `databasePath`. Feeds the shared `resolveAdapter()`
   * selection point.
   */
  databaseUrl: string | null;
  webHost: string;
  webPort: number;
  sqlStudioEnabled: boolean;
  sqlStudioHost: string;
  sqlStudioPort: number;
  sqlStudioBinary: string;
  defaultAgent: string;
  defaultModel: string | null;
  /**
   * How `ovld launch` / the runner open the agent in a new terminal window.
   * A built-in name (`iTerm2`, `Terminal`) or a raw prefix command
   * (e.g. `open -a Ghostty --args`). `null` launches the agent inline.
   */
  terminalLauncher: string | null;
  /** Parsed from `[agent_catalog]`; merged over bundled defaults when seeding the workspace catalog. */
  agentCatalog: Record<string, CatalogAgent> | null;
};

const DEFAULT_CONFIG: OverlordConfig = {
  instanceName: 'Local Overlord',
  backendMode: 'local',
  backendUrl: null,
  databasePath: null,
  databaseUrl: null,
  webHost: '127.0.0.1',
  webPort: 4310,
  sqlStudioEnabled: false,
  sqlStudioHost: '127.0.0.1',
  sqlStudioPort: 4311,
  sqlStudioBinary: 'sql-studio',
  defaultAgent: 'claude',
  defaultModel: null,
  terminalLauncher: null,
  agentCatalog: null
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

type TomlConfig = {
  instance_name?: string;
  backend_mode?: string;
  backend_url?: string;
  database_path?: string;
  database_url?: string;
  web_host?: string;
  web_port?: number;
  sql_studio_enabled?: boolean;
  sql_studio_host?: string;
  sql_studio_port?: number;
  sql_studio_binary?: string;
  default_agent?: string;
  default_model?: string;
  terminal_launcher?: string;
  agent_catalog?: unknown;
};

function parseTomlConfig(raw: string): TomlConfig {
  try {
    return parse(raw) as TomlConfig;
  } catch {
    return {};
  }
}

function configFromToml(toml: TomlConfig): OverlordConfig {
  const backendMode: BackendMode = toml.backend_mode === 'cloud' ? 'cloud' : 'local';
  return {
    instanceName: toml.instance_name ?? DEFAULT_CONFIG.instanceName,
    backendMode,
    backendUrl: toml.backend_url?.trim() ? toml.backend_url.trim() : null,
    databasePath: toml.database_path?.trim() ? toml.database_path.trim() : null,
    databaseUrl: toml.database_url?.trim() ? toml.database_url.trim() : null,
    webHost: toml.web_host ?? DEFAULT_CONFIG.webHost,
    webPort: typeof toml.web_port === 'number' ? toml.web_port : DEFAULT_CONFIG.webPort,
    sqlStudioEnabled:
      typeof toml.sql_studio_enabled === 'boolean'
        ? toml.sql_studio_enabled
        : DEFAULT_CONFIG.sqlStudioEnabled,
    sqlStudioHost: toml.sql_studio_host ?? DEFAULT_CONFIG.sqlStudioHost,
    sqlStudioPort:
      typeof toml.sql_studio_port === 'number'
        ? toml.sql_studio_port
        : DEFAULT_CONFIG.sqlStudioPort,
    sqlStudioBinary: toml.sql_studio_binary?.trim()
      ? toml.sql_studio_binary
      : DEFAULT_CONFIG.sqlStudioBinary,
    defaultAgent: toml.default_agent ?? DEFAULT_CONFIG.defaultAgent,
    defaultModel: toml.default_model?.trim() ? toml.default_model : null,
    terminalLauncher: toml.terminal_launcher?.trim() ? toml.terminal_launcher.trim() : null,
    agentCatalog: parseAgentCatalogFromToml(toml.agent_catalog)
  };
}

export function resolveProjectRoot(startDir = process.cwd()): string {
  const configPath = findConfigPath(startDir);
  if (configPath) {
    return path.dirname(configPath);
  }
  return startDir;
}

export function resolveRepoPath(relativePath: string, startDir = process.cwd()): string {
  return path.resolve(resolveProjectRoot(startDir), relativePath);
}

export function findConfigPath(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'overlord.toml');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveGlobalDataDir(): string {
  return process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld');
}

export function resolveGlobalConfigPath(): string {
  return path.join(resolveGlobalDataDir(), 'overlord.toml');
}

export function findEffectiveConfigPath(startDir = process.cwd()): string | null {
  const localPath = findConfigPath(startDir);
  if (localPath) return localPath;

  const globalPath = resolveGlobalConfigPath();
  return existsSync(globalPath) ? globalPath : null;
}

export function resolveConfigWritePath(startDir = process.cwd()): string {
  return findConfigPath(startDir) ?? resolveGlobalConfigPath();
}

export function loadConfig(configPath?: string | null): OverlordConfig {
  const resolvedPath = configPath ?? findEffectiveConfigPath();
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(resolvedPath, 'utf8');
  return configFromToml(parseTomlConfig(raw));
}

export function writeConfig({
  targetPath,
  config
}: {
  targetPath: string;
  config: Partial<OverlordConfig>;
}): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const merged = { ...DEFAULT_CONFIG, ...config };
  const contents = `# Overlord local instance configuration
instance_name = ${tomlString(merged.instanceName)}
backend_mode = ${tomlString(merged.backendMode)}
${merged.backendUrl ? `backend_url = ${tomlString(merged.backendUrl)}` : `backend_url = ${tomlString(DEFAULT_LOCAL_BACKEND_URL)}`}

# Published CLI backend target.
# Local mode expects a Desktop/local backend listening on the loopback URL.
# Cloud mode points at a hosted Overlord backend.
#
# backend_mode = "local"
# backend_url = "http://127.0.0.1:4310"
# backend_mode = "cloud"
# backend_url = "https://overlord.example.com"

${merged.databasePath ? `database_path = ${tomlString(merged.databasePath)}` : '# database_path = ""'}
# Legacy local-backend database location. The published npm CLI does not open
# SQLite; these keys are consumed only by local backend packages such as Desktop.
# database_path = "./database/.local/Overlord.sqlite"
#
# Legacy backend database URL for backend packages that talk directly to Postgres.
${merged.databaseUrl ? `database_url = ${tomlString(merged.databaseUrl)}` : '# database_url = "postgres://user:password@host:5432/overlord"'}
web_host = ${tomlString(merged.webHost)}
web_port = ${merged.webPort}
sql_studio_enabled = ${merged.sqlStudioEnabled}
sql_studio_host = ${tomlString(merged.sqlStudioHost)}
sql_studio_port = ${merged.sqlStudioPort}
sql_studio_binary = ${tomlString(merged.sqlStudioBinary)}
default_agent = ${tomlString(merged.defaultAgent)}
${merged.defaultModel ? `default_model = ${tomlString(merged.defaultModel)}` : '# default_model = ""'}
${merged.terminalLauncher ? `terminal_launcher = ${tomlString(merged.terminalLauncher)}\n` : ''}
# Terminal launcher: open the launched agent in a new terminal window.
# Built-in launchers (macOS): "iTerm2" and "Terminal" use AppleScript so the
# agent opens in a fresh window in the project directory.
# terminal_launcher = "iTerm2"
# terminal_launcher = "Terminal"
# Any other value is treated as a prefix command with the agent invocation appended:
# terminal_launcher = "open -a Ghostty --args"
# terminal_launcher = "wezterm start"

# Optional workspace agent catalog (merged over bundled defaults on first seed / refresh).
# [agent_catalog.claude]
# label = "Claude Code"
# available_by_default = true
# reasoning_label = "Thinking"
#
# [[agent_catalog.claude.models]]
# id = "claude-sonnet-4-6"
# display_name = "Sonnet 4.6"
# reasoning_options = ["low", "medium", "high"]
`;

  writeFileSync(targetPath, contents);
}

export function hasExplicitBackendConfig(config: OverlordConfig): boolean {
  return Boolean(config.backendUrl?.trim());
}

/**
 * Expand a leading `~` (or `~/…`) to the user's home directory. TOML strings
 * are not shell-expanded, so `database_path = "~/.ovld/Overlord.sqlite"` would
 * otherwise be treated as a relative `./~/…` path. Other paths are returned
 * unchanged.
 */
function expandTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveDatabasePath(config: OverlordConfig, startDir = process.cwd()): string {
  const explicit = process.env.OVERLORD_SQLITE_PATH;
  if (explicit) {
    const expanded = expandTilde(explicit);
    return path.isAbsolute(expanded)
      ? expanded
      : path.resolve(resolveProjectRoot(startDir), expanded);
  }

  // No developer override: use the per-user global default (`~/.ovld/...`).
  if (!config.databasePath) {
    return path.join(resolveGlobalDataDir(), 'Overlord.sqlite');
  }

  const expanded = expandTilde(config.databasePath);
  const configPath = findConfigPath(startDir);
  const baseDir = configPath ? path.dirname(configPath) : resolveProjectRoot(startDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

export function resolveBackendUrl(config: OverlordConfig): string {
  return config.backendUrl?.trim() || DEFAULT_LOCAL_BACKEND_URL;
}

/**
 * Bridge the admin `database_url` from `overlord.toml` into `DATABASE_URL` so
 * the components that already resolve the database from the environment — the
 * auth layer and `resolveAdapter()` — coordinate with the toml without each
 * needing to re-read the config. An existing `DATABASE_URL` is left untouched.
 */
export function applyDatabaseEnv(config: OverlordConfig): void {
  if (config.databaseUrl && !process.env.DATABASE_URL?.trim()) {
    process.env.DATABASE_URL = config.databaseUrl;
  }
}
