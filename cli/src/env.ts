import { parse as parseDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type EnvProfile = 'development' | 'production';

export function resolveEnvFileNames(profile: EnvProfile): string[] {
  return profile === 'production' ? ['.env.prod'] : ['.env.local'];
}

/** True when a built module lives inside an installed package (`node_modules`). */
export function isInstalledModulePath(moduleDir: string): boolean {
  return /[\\/]node_modules[\\/]/.test(moduleDir);
}

/**
 * Default env profile for a bare `ovld` invocation. The **installed/published**
 * CLI (under `node_modules`) runs as `production`: it never auto-loads `.env.local`
 * and never reads the dev-only `OVERLORD_BACKEND_URL_DEV`, so a development variable
 * can never leak into a production CLI even when it is run from inside a dev
 * checkout. Only the in-repo source build — and the dev/test tooling that runs it
 * (`yarn dev`, `with-ovld-home`) — defaults to `development`. Webapp/server and
 * desktop pass their own profile explicitly and are unaffected.
 */
export function detectCliEnvProfile(): EnvProfile {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return isInstalledModulePath(moduleDir) ? 'production' : 'development';
  } catch {
    return 'development';
  }
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
        process.env[key] = normalizeEnvFileValue({ key, value, baseDir: path.dirname(filePath) });
      }
    }
  }
}

function normalizeEnvFileValue({
  key,
  value,
  baseDir
}: {
  key: string;
  value: string;
  baseDir: string;
}): string {
  if (key !== 'OVLD_HOME') return value;
  if (!value.trim() || path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}
