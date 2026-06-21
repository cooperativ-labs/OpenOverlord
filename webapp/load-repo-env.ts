import { config as loadEnv } from 'dotenv';
import path from 'node:path';

import { type EnvProfile } from '../cli/src/env.ts';

export function loadRepoEnv(path: string): void {
  loadRepoEnvFiles([path]);
}

export function loadRepoEnvForProfile(repoRoot: string, profile: EnvProfile): void {
  const fileName = profile === 'production' ? '.env.prod' : '.env.local';
  loadRepoEnvFiles([path.join(repoRoot, fileName)]);
  // Development backend resolution reads `OVERLORD_BACKEND_URL_DEV` directly (see
  // `resolveBackendUrl`); it is intentionally not mirrored into the production
  // `OVERLORD_BACKEND_URL` so the dev and prod channels never collide.
}

export function loadRepoEnvFiles(paths: string[]): void {
  const merged: Record<string, string> = {};

  for (const envPath of paths) {
    const result = loadEnv({ path: envPath, processEnv: {}, quiet: true });
    for (const [key, value] of Object.entries(result.parsed ?? {})) {
      merged[key] = normalizeEnvFileValue({
        key,
        value,
        baseDir: path.dirname(envPath)
      });
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env) || !process.env[key]?.trim()) {
      process.env[key] = value;
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
