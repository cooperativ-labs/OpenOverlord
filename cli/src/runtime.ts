import {
  fixupLocalStoragePaths,
  migrateDatabase,
  openDatabase,
  type OverlordDatabase
} from '@overlord/database';
import { existsSync } from 'node:fs';

import { createServiceContext, type ServiceContext } from '../../src/service/context.js';

import { applyDatabaseEnv, loadConfig, resolveDatabasePath } from './config.js';
import { CliError } from './errors.js';

export type CliRuntime = {
  db: OverlordDatabase;
  ctx: ServiceContext;
  close: () => void;
};

export function openCliRuntime({ source }: { source: ServiceContext['source'] }): CliRuntime {
  const config = loadConfig();
  // Coordinate auth + the shared adapter with any admin-configured cloud DB.
  applyDatabaseEnv(config);
  const databasePath = resolveDatabasePath(config);

  if (!existsSync(databasePath)) {
    throw new CliError({
      message:
        `Overlord database not found at ${databasePath}.\n` +
        'Run `ovld init` then `yarn start:local` from the repo root.'
    });
  }

  const db = openDatabase({ databasePath });
  migrateDatabase(db);
  fixupLocalStoragePaths(db, databasePath);
  const ctx = createServiceContext({ db, source });

  return {
    db,
    ctx,
    close: () => db.close()
  };
}
