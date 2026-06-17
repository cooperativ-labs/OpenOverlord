import { type SqlStudioHandle, startSqlStudio } from './sql-studio.ts';

type SqlStudioRuntimeConfig = {
  binary: string;
  host: string;
  port: number;
  databasePath: string;
};

let runtimeConfig: SqlStudioRuntimeConfig | null = null;
let handle: SqlStudioHandle | null = null;
let signalsRegistered = false;

function registerSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  const shutdown = () => {
    handle?.stop();
    handle = null;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', shutdown);
}

export function initSqlStudioManager(config: SqlStudioRuntimeConfig): void {
  runtimeConfig = config;
  registerSignalHandlers();
}

export function syncSqlStudioForWorkspace({ enabled }: { enabled: boolean }): void {
  if (!runtimeConfig) return;

  handle?.stop();
  handle = null;

  if (!enabled) return;

  handle = startSqlStudio({
    enabled: true,
    binary: runtimeConfig.binary,
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    databasePath: runtimeConfig.databasePath
  });
}

export function getSqlStudioState(): { enabled: boolean; url: string | null } {
  return {
    enabled: Boolean(handle?.url),
    url: handle?.url ?? null
  };
}
