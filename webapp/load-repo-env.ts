import { config as loadEnv } from 'dotenv';

export function loadRepoEnv(path: string): void {
  const result = loadEnv({ path, processEnv: {} });
  const parsed = result.parsed ?? {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env) || !process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}
