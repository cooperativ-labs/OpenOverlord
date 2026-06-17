#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const [mode, value] = process.argv.slice(2);

if (mode === 'view') {
  process.stdout.write(JSON.stringify(value ?? '0.0.0'));
  process.exit(0);
}

if (mode === 'install') {
  const sentinel = process.env.OVLD_UPDATE_SENTINEL;
  if (sentinel) {
    writeFileSync(sentinel, 'installed\n', 'utf8');
  }
  process.stdout.write('mock install complete\n');
  process.exit(0);
}

process.stderr.write(`unknown mode: ${mode ?? '(missing)'}\n`);
process.exit(1);
