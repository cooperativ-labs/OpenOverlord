import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..');

function applyEnvFile(filePath, { skipKeys = [] } = {}) {
  if (!existsSync(filePath)) return;

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (skipKeys.includes(key)) continue;
    const rawValue = parseEnvValue(trimmed.slice(eq + 1));

    if (!process.env[key]?.trim()) {
      process.env[key] = normalizeEnvFileValue({
        key,
        value: rawValue,
        baseDir: path.dirname(filePath)
      });
    }
  }
}

function parseEnvValue(rawValue) {
  let value = rawValue.trim();
  let quote = null;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && (i === 0 || value[i - 1] !== '\\')) {
      quote = quote === char ? null : (quote ?? char);
      continue;
    }
    if (char === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      value = value.slice(0, i).trim();
      break;
    }
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value;
}

function normalizeEnvFileValue({ key, value, baseDir }) {
  if (key !== 'OVLD_HOME') return value;
  if (!value.trim() || path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

/** @param {{ repoRoot?: string, profile?: 'development' | 'production', skipKeys?: string[] }} [options] */
export function loadRepoEnvForProfile({
  repoRoot: root = repoRoot,
  profile = 'development',
  skipKeys = []
} = {}) {
  const fileName = profile === 'production' ? '.env.prod' : '.env.local';
  applyEnvFile(path.join(root, fileName), { skipKeys });
  // Development backend resolution reads `OVERLORD_BACKEND_URL_DEV` directly (see
  // `resolveBackendUrl`); we intentionally do NOT mirror it into the production
  // `OVERLORD_BACKEND_URL` so the two channels never collide.
}
