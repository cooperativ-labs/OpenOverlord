import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type OverlordConfig = {
  instanceName: string;
  databasePath: string;
  webHost: string;
  webPort: number;
  defaultAgent: string;
  defaultModel: string | null;
};

const DEFAULT_CONFIG: OverlordConfig = {
  instanceName: 'Local Overlord',
  databasePath: '.overlord/Overlord.sqlite',
  webHost: '127.0.0.1',
  webPort: 4310,
  defaultAgent: 'claude',
  defaultModel: null
};

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
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(resolvedPath, 'utf8');
  const config = { ...DEFAULT_CONFIG };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '');

    switch (key) {
      case 'instance_name':
        config.instanceName = value;
        break;
      case 'database_path':
        config.databasePath = value;
        break;
      case 'web_host':
        config.webHost = value;
        break;
      case 'web_port':
        config.webPort = Number.parseInt(value, 10);
        break;
      case 'default_agent':
        config.defaultAgent = value;
        break;
      case 'default_model':
        config.defaultModel = value || null;
        break;
      default:
        break;
    }
  }

  return config;
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
default_agent = "${merged.defaultAgent}"
${merged.defaultModel ? `default_model = "${merged.defaultModel}"` : '# default_model = ""'}

# Common terminal launchers (examples):
# terminal_launcher = "open -a Ghostty --args"
# terminal_launcher = "wezterm start"
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
