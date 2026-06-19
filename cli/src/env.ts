import { parse as parseDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type EnvProfile = 'development' | 'production';

export function resolveEnvFileNames(profile: EnvProfile): string[] {
  return profile === 'production' ? ['.env.prod'] : ['.env.local'];
}

function snapshotRuntimeEnv(): Set<string> {
  return new Set(
    Object.entries(process.env)
      .filter(([, value]) => Boolean(value?.trim()))
      .map(([key]) => key)
  );
}

/**
 * Snapshot of which env vars were set by the real process environment (shell
 * export, Docker/launcher injection) before this module ever loads a `.env`
 * file. Captured once at import time, which always runs before any call to
 * `loadEnvDefaults` below — so a later `isExplicitRuntimeEnv(key)` can tell a
 * genuine runtime override apart from a value that only exists because a
 * `.env` file backfilled it.
 */
let explicitRuntimeKeys = snapshotRuntimeEnv();

export function isExplicitRuntimeEnv(key: string): boolean {
  return explicitRuntimeKeys.has(key);
}

/**
 * Profile-aware env resolution for keys mirrored in `overlord.toml`.
 * Development: explicit runtime > env file > toml > fallback.
 * Production: explicit runtime > toml > env file > fallback.
 */
export function resolveLayeredEnv({
  envKey,
  configValue,
  fallback = '',
  envProfile = 'development'
}: {
  envKey: string;
  configValue: string;
  fallback?: string;
  envProfile?: EnvProfile;
}): string {
  const value = process.env[envKey]?.trim();
  if (value && isExplicitRuntimeEnv(envKey)) return value;
  if (envProfile === 'development' && value) return value;
  if (configValue) return configValue;
  return value || fallback;
}

/**
 * Test-only: re-snapshot the runtime environment. Production code never calls
 * this — the snapshot is meant to be captured exactly once, before any `.env`
 * file is loaded, for the lifetime of a single process. Tests that mutate
 * `process.env` across cases within one process need to re-establish the
 * "before .env loaded" baseline themselves.
 */
export function resetExplicitRuntimeEnvForTests(): void {
  explicitRuntimeKeys = snapshotRuntimeEnv();
}

/**
 * Backfills `process.env` from the env file for `profile` in `dir`, without
 * overwriting any value already present. Development workflows read `.env.local`
 * only; production/packaged workflows read `.env.prod` only. Missing files are
 * silently skipped — most `ovld` invocations (global installs, arbitrary
 * working directories) have neither.
 */
export function loadEnvDefaults(dir: string, profile: EnvProfile = 'development'): void {
  for (const file of resolveEnvFileNames(profile)) {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    const parsed = parseDotenv(readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!process.env[key]?.trim()) {
        process.env[key] = value;
      }
    }
  }
}
