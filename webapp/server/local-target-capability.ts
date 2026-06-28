import type { SqlDialect } from '@overlord/database';

export type LocalTargetServerCapability = 'in_process_server' | 'unavailable';

/** Opt-in dev fallback: browser + loopback SQLite without the desktop shell. */
export function isDevInProcessLocalTargetEnabled(): boolean {
  return process.env.OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET === 'true';
}

/**
 * Reports which server-side local-target transport this backend build exposes.
 * Desktop clients use `window.overlord` for checkout work on all backends.
 * The in-process dev proxy is opt-in via `OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true`.
 */
export function resolveLocalTargetServerCapability({
  dialect
}: {
  dialect: SqlDialect;
}): LocalTargetServerCapability {
  if (dialect === 'sqlite' && isDevInProcessLocalTargetEnabled()) {
    return 'in_process_server';
  }
  return 'unavailable';
}
