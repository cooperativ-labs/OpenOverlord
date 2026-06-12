import { migrateDatabase, openDatabase, type OverlordDatabase } from '@overlord/database';
import { existsSync } from 'node:fs';

import { createServiceContext, type ServiceContext } from '../../src/service/context.js';

import { loadConfig, resolveDatabasePath } from './config.js';
import { CliError } from './errors.js';

export type CliRuntime = {
  db: OverlordDatabase;
  ctx: ServiceContext;
  close: () => void;
};

export function openCliRuntime({ source }: { source: ServiceContext['source'] }): CliRuntime {
  const config = loadConfig();
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
  const ctx = createServiceContext({ db, source });

  return {
    db,
    ctx,
    close: () => db.close()
  };
}
