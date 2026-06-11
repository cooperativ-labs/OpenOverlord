#!/usr/bin/env node

import { runCli } from '../dist/cli/src/index.js';

runCli({ primaryCommand: 'ovld' }).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
