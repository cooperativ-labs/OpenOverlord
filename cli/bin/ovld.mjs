#!/usr/bin/env node

import { redactSecrets, runCli } from '../dist/index.js';

runCli({ primaryCommand: 'ovld' }).catch(error => {
  console.error(redactSecrets(error instanceof Error ? error.message : error));
  process.exit(1);
});
