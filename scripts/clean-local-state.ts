import { LOCAL_DATA_DIR } from '@overlord/database';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, resolveDatabasePath, resolveProjectRoot } from '../cli/src/config.ts';

import { stopLocalDev } from './stop-local-dev.ts';

stopLocalDev();

const projectRoot = resolveProjectRoot();
const databasePath = resolveDatabasePath(loadConfig(), projectRoot);

const targets = [
  path.join(projectRoot, LOCAL_DATA_DIR),
  databasePath,
  `${databasePath}-shm`,
  `${databasePath}-wal`,
  path.join(projectRoot, 'dist'),
  path.join(projectRoot, 'cli', 'dist'),
  path.join(projectRoot, 'webapp', 'dist')
];

for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${path.relative(projectRoot, target) || target}`);
}
