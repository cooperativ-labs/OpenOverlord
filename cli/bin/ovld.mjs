#!/usr/bin/env node

import { runCli } from '../dist/index.js';

runCli({ primaryCommand: 'ovld' }).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
