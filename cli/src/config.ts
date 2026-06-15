import type { AdapterConfig } from '@overlord/database';
import { resolveAdapter, resolveGlobalDatabasePath } from '@overlord/database';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

import { parseAgentCatalogFromToml } from './agent-catalog.ts';
import type { CatalogAgent } from './agent-catalog-defaults.ts';

export type OverlordConfig = {
  instanceName: string;
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

type TomlConfig = {
  instance_name?: string;
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
  return {
    instanceName: toml.instance_name ?? DEFAULT_CONFIG.instanceName,
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

export function loadConfig(configPath?: string | null): OverlordConfig {
  const resolvedPath = configPath ?? findConfigPath();
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
instance_name = "${merged.instanceName}"
${merged.databasePath ? `database_path = "${merged.databasePath}"` : '# database_path = ""'}
# Database location.
# By default the SQLite database lives in the per-user global directory
# (~/.ovld/Overlord.sqlite), so a single global install is shared across every
# project directory. Set database_path to override the location for this
# instance (relative paths resolve against this file's directory):
# database_path = "./database/.local/Overlord.sqlite"
#
# Cloud / hosted database (admins): point Overlord at a hosted database instead
# of a local SQLite file by setting a connection string. This feeds the shared
# adapter-selection point and is equivalent to exporting DATABASE_URL.
${merged.databaseUrl ? `database_url = "${merged.databaseUrl}"` : '# database_url = "postgres://user:password@host:5432/overlord"'}
web_host = "${merged.webHost}"
web_port = ${merged.webPort}
sql_studio_enabled = ${merged.sqlStudioEnabled}
sql_studio_host = "${merged.sqlStudioHost}"
sql_studio_port = ${merged.sqlStudioPort}
sql_studio_binary = "${merged.sqlStudioBinary}"
default_agent = "${merged.defaultAgent}"
${merged.defaultModel ? `default_model = "${merged.defaultModel}"` : '# default_model = ""'}
${merged.terminalLauncher ? `terminal_launcher = "${merged.terminalLauncher}"\n` : ''}
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
    return resolveGlobalDatabasePath();
  }

  const expanded = expandTilde(config.databasePath);
  const configPath = findConfigPath(startDir);
  const baseDir = configPath ? path.dirname(configPath) : resolveProjectRoot(startDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

/**
 * The single answer to "where does this instance's database live?" — a cloud
 * connection string (`database_url`) when an admin has configured one,
 * otherwise the local SQLite file at the resolved {@link resolveDatabasePath}.
 * Delegates the sqlite/postgres decision to the shared `resolveAdapter()`.
 */
export function resolveDatabaseTarget(
  config: OverlordConfig,
  startDir = process.cwd()
): AdapterConfig {
  return resolveAdapter({
    databaseUrl: config.databaseUrl ?? undefined,
    databasePath: resolveDatabasePath(config, startDir)
  });
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
