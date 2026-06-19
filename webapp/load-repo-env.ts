import { config as loadEnv } from 'dotenv';
import path from 'node:path';

import { type EnvProfile } from '../cli/src/env.ts';

export function loadRepoEnv(path: string): void {
  loadRepoEnvFiles([path]);
}

export function loadRepoEnvForProfile(repoRoot: string, profile: EnvProfile): void {
  const fileName = profile === 'production' ? '.env.prod' : '.env.local';
  loadRepoEnvFiles([path.join(repoRoot, fileName)]);
}

export function loadRepoEnvFiles(paths: string[]): void {
  const merged: Record<string, string> = {};

  for (const path of paths) {
    const result = loadEnv({ path, processEnv: {}, quiet: true });
    Object.assign(merged, result.parsed ?? {});
  }

  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env) || !process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}
