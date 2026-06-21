import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { loadRepoEnv, loadRepoEnvFiles, loadRepoEnvForProfile } from '../load-repo-env.ts';

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'OVLD_HOME',
  'OVERLORD_WEB_PORT',
  'OVERLORD_BACKEND_URL',
  'OVERLORD_BACKEND_URL_DEV'
] as const;

function withCleanEnv<T>(fn: () => T): T {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeEnvFile(contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-load-env-'));
  tempDirs.push(dir);
  const file = path.join(dir, '.env');
  writeFileSync(file, contents);
  return file;
}

describe('loadRepoEnv', () => {
  it('loads values from .env when the process env is unset', () => {
    withCleanEnv(() => {
      const envPath = makeEnvFile('GEMINI_API_KEY=from-dotenv\nOVERLORD_WEB_PORT=4310\n');

      loadRepoEnv(envPath);

      assert.equal(process.env.GEMINI_API_KEY, 'from-dotenv');
      assert.equal(process.env.OVERLORD_WEB_PORT, '4310');
    });
  });

  it('replaces blank exported values with .env values', () => {
    withCleanEnv(() => {
      process.env.GEMINI_API_KEY = '   ';
      const envPath = makeEnvFile('GEMINI_API_KEY=from-dotenv\n');

      loadRepoEnv(envPath);

      assert.equal(process.env.GEMINI_API_KEY, 'from-dotenv');
    });
  });

  it('preserves non-blank process env overrides', () => {
    withCleanEnv(() => {
      process.env.GEMINI_API_KEY = 'from-process';
      const envPath = makeEnvFile('GEMINI_API_KEY=from-dotenv\n');

      loadRepoEnv(envPath);

      assert.equal(process.env.GEMINI_API_KEY, 'from-process');
    });
  });

  it('loads development profile from .env.local only', () => {
    withCleanEnv(() => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-load-env-'));
      tempDirs.push(dir);
      writeFileSync(
        path.join(dir, '.env.prod'),
        'OVERLORD_WEB_PORT=4310\nGEMINI_API_KEY=from-prod\n'
      );
      writeFileSync(
        path.join(dir, '.env.local'),
        'OVERLORD_WEB_PORT=4320\nGEMINI_API_KEY=from-dev\n'
      );

      loadRepoEnvForProfile(dir, 'development');

      assert.equal(process.env.OVERLORD_WEB_PORT, '4320');
      assert.equal(process.env.GEMINI_API_KEY, 'from-dev');
    });
  });

  it('loads the development backend URL without polluting the production variable', () => {
    withCleanEnv(() => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-env-'));
      tempDirs.push(dir);
      writeFileSync(
        path.join(dir, '.env.local'),
        'OVERLORD_BACKEND_URL_DEV=http://127.0.0.1:4320\n'
      );

      loadRepoEnvForProfile(dir, 'development');

      // Development resolves the backend from OVERLORD_BACKEND_URL_DEV directly;
      // the production OVERLORD_BACKEND_URL must stay untouched.
      assert.equal(process.env.OVERLORD_BACKEND_URL_DEV, 'http://127.0.0.1:4320');
      assert.equal(process.env.OVERLORD_BACKEND_URL, undefined);
    });
  });

  it('resolves relative OVLD_HOME values from the env file directory', () => {
    withCleanEnv(() => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-env-'));
      tempDirs.push(dir);
      writeFileSync(path.join(dir, '.env.local'), 'OVLD_HOME=database/.local/dev-home\n');

      loadRepoEnvForProfile(dir, 'development');

      assert.equal(process.env.OVLD_HOME, path.join(dir, 'database/.local/dev-home'));
    });
  });

  it('loads production profile from .env.prod only', () => {
    withCleanEnv(() => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ovld-load-env-'));
      tempDirs.push(dir);
      writeFileSync(
        path.join(dir, '.env.prod'),
        'OVERLORD_WEB_PORT=4310\nGEMINI_API_KEY=from-prod\n'
      );
      writeFileSync(path.join(dir, '.env.local'), 'OVERLORD_WEB_PORT=4320\n');

      loadRepoEnvForProfile(dir, 'production');

      assert.equal(process.env.OVERLORD_WEB_PORT, '4310');
      assert.equal(process.env.GEMINI_API_KEY, 'from-prod');
    });
  });
});
