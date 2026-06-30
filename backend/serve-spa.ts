import type { SqlDialect } from '@overlord/database';

function parseTruthyEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return null;
}

/**
 * Whether the REST server should mount the built SPA (`express.static` + HTML
 * fallback). Cloud/Postgres control planes are API-only — Vercel serves the web
 * client per the contract. Local SQLite (desktop, `ovld serve`) keeps
 * same-origin static serving when `webapp/dist` is present.
 */
export function resolveServeSpa({
  dialect,
  env = process.env
}: {
  dialect: SqlDialect;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const explicit = parseTruthyEnv(env.OVERLORD_SERVE_SPA);
  if (explicit !== null) return explicit;
  return dialect === 'sqlite';
}
