import { DEFAULT_DATABASE_PATH } from '@overlord/database';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

import { parseAgentCatalogFromToml } from './agent-catalog.ts';
import type { CatalogAgent } from './agent-catalog-defaults.ts';

export type OverlordConfig = {
  instanceName: string;
  databasePath: string;
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
  databasePath: DEFAULT_DATABASE_PATH,
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
    databasePath: toml.database_path ?? DEFAULT_CONFIG.databasePath,
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
database_path = "${merged.databasePath}"
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

export function resolveDatabasePath(config: OverlordConfig, startDir = process.cwd()): string {
  const explicit = process.env.OVERLORD_SQLITE_PATH;
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(resolveProjectRoot(startDir), explicit);
  }

  const configPath = findConfigPath(startDir);
  const baseDir = configPath ? path.dirname(configPath) : resolveProjectRoot(startDir);
  return path.isAbsolute(config.databasePath)
    ? config.databasePath
    : path.resolve(baseDir, config.databasePath);
}
