import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ActiveBackend, BackendProfile } from './backend-profiles.js';

function globalConfigPath(): string {
  return path.join(
    process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld'),
    'overlord.toml'
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function syncOverlordTomlForProfile({
  profile,
  shellOrigin
}: {
  profile: BackendProfile;
  shellOrigin: string;
}): void {
  const targetPath = globalConfigPath();
  mkdirSync(path.dirname(targetPath), { recursive: true });

  const backendMode = profile.mode === 'local' ? 'local' : 'cloud';
  const backendUrl = profile.mode === 'local' ? shellOrigin : profile.backendUrl;
  const parsedShell = new URL(shellOrigin);
  const webHost = parsedShell.hostname;
  const webPort = parsedShell.port
    ? Number(parsedShell.port)
    : parsedShell.protocol === 'https:'
      ? 443
      : 80;

  const existing = existsSync(targetPath) ? readExistingConfig(targetPath) : {};
  const next = {
    instanceName: existing.instanceName ?? 'Local Overlord',
    backendMode,
    backendUrl,
    webHost: existing.webHost ?? webHost,
    webPort: existing.webPort ?? webPort,
    sqlStudioEnabled: existing.sqlStudioEnabled ?? false,
    sqlStudioHost: existing.sqlStudioHost ?? '127.0.0.1',
    sqlStudioPort: existing.sqlStudioPort ?? 4311,
    sqlStudioBinary: existing.sqlStudioBinary ?? 'sql-studio',
    defaultAgent: existing.defaultAgent ?? 'claude'
  };

  writeFileSync(
    targetPath,
    `# Overlord instance configuration
instance_name = ${tomlString(next.instanceName)}
backend_mode = ${tomlString(next.backendMode)}
backend_url = ${tomlString(next.backendUrl)}
web_host = ${tomlString(next.webHost)}
web_port = ${next.webPort}
sql_studio_enabled = ${next.sqlStudioEnabled ? 'true' : 'false'}
sql_studio_host = ${tomlString(next.sqlStudioHost)}
sql_studio_port = ${next.sqlStudioPort}
sql_studio_binary = ${tomlString(next.sqlStudioBinary)}
default_agent = ${tomlString(next.defaultAgent)}
`
  );
}

type ExistingConfig = {
  instanceName?: string;
  webHost?: string;
  webPort?: number;
  sqlStudioEnabled?: boolean;
  sqlStudioHost?: string;
  sqlStudioPort?: number;
  sqlStudioBinary?: string;
  defaultAgent?: string;
};

function readExistingConfig(filePath: string): ExistingConfig {
  const text = readFileSyncSafe(filePath);
  const config: ExistingConfig = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const value = parseTomlString(rawValue);
    switch (key) {
      case 'instance_name':
        config.instanceName = value;
        break;
      case 'web_host':
        config.webHost = value;
        break;
      case 'web_port':
        config.webPort = Number(value);
        break;
      case 'sql_studio_enabled':
        config.sqlStudioEnabled = value === 'true';
        break;
      case 'sql_studio_host':
        config.sqlStudioHost = value;
        break;
      case 'sql_studio_port':
        config.sqlStudioPort = Number(value);
        break;
      case 'sql_studio_binary':
        config.sqlStudioBinary = value;
        break;
      case 'default_agent':
        config.defaultAgent = value;
        break;
      default:
        break;
    }
  }
  return config;
}

function readFileSyncSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseTomlString(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

export function activeBackendForRenderer(active: ActiveBackend): {
  id: string;
  label: string;
  mode: 'local' | 'remote';
  backendUrl: string;
  apiBaseUrl: string;
  shellOrigin: string;
} {
  return {
    id: active.id,
    label: active.label,
    mode: active.mode,
    backendUrl: active.apiBaseUrl,
    apiBaseUrl: active.apiBaseUrl,
    shellOrigin: active.shellOrigin
  };
}
