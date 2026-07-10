import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const desktopDir = process.cwd();

test('electron-builder keeps the established macOS update identity', () => {
  const config = readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');

  assert.match(config, /^appId: io\.cooperativ\.openoverlord$/m);
});
