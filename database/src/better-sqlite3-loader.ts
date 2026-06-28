import type BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';

type BetterSqlite3Constructor = typeof BetterSqlite3;

let cached: BetterSqlite3Constructor | null = null;

/**
 * Load `better-sqlite3` on first use so Postgres-only runtimes (the cloud
 * control-plane image) never touch the native addon at boot.
 */
export function loadBetterSqlite3(): BetterSqlite3Constructor {
  if (!cached) {
    const require = createRequire(import.meta.url);
    cached = require('better-sqlite3') as BetterSqlite3Constructor;
  }
  return cached;
}

export type BetterSqlite3Database = BetterSqlite3.Database;
