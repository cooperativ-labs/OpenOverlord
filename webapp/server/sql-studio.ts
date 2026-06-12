import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

type SqlStudioConfig = {
  enabled: boolean;
  binary: string;
  host: string;
  port: number;
  databasePath: string;
};

type SqlStudioHandle = {
  url: string | null;
  stop: () => void;
};

function publicHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

export function sqlStudioUrl({
  enabled,
  host,
  port
}: Pick<SqlStudioConfig, 'enabled' | 'host' | 'port'>) {
  if (!enabled) return null;
  return `http://${publicHost(host)}:${port}`;
}

function resolveBinary(binary: string): string | null {
  if (path.isAbsolute(binary)) {
    return existsSync(binary) ? binary : null;
  }
  if (binary.includes('/')) {
    return existsSync(binary) ? binary : null;
  }
  return binary;
}

export function startSqlStudio(config: SqlStudioConfig): SqlStudioHandle {
  const url = sqlStudioUrl(config);
  if (!config.enabled || !url) {
    return { url: null, stop: () => undefined };
  }

  const binary = resolveBinary(config.binary);
  if (binary === null) {
    console.warn(
      `[sql-studio] binary '${config.binary}' not found. Install SQL Studio, set sql_studio_binary in overlord.toml, or set sql_studio_enabled = false.`
    );
    return { url: null, stop: () => undefined };
  }

  const args = [
    '--no-browser',
    '--no-shutdown',
    `--address=${config.host}:${config.port}`,
    'sqlite',
    config.databasePath
  ];
  const launched = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let child: typeof launched | null = launched;

  launched.stdout.on('data', data => {
    process.stdout.write(`[sql-studio] ${data}`);
  });
  launched.stderr.on('data', data => {
    process.stderr.write(`[sql-studio] ${data}`);
  });
  launched.on('error', error => {
    console.error(
      `[sql-studio] failed to start '${config.binary}'. Install SQL Studio or set sql_studio_binary in overlord.toml.`
    );
    console.error(`[sql-studio] ${error.message}`);
  });
  launched.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[sql-studio] exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
    }
    child = null;
  });

  console.log(`[sql-studio] launching ${url}`);

  const stop = () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);

  return { url, stop };
}
