import { flagBoolean, flagValue, parseArgs } from './args.js';
import {
  listAvailableConnectors,
  setupAllConnectors,
  setupConnector,
  type SetupResult
} from './connectors.js';
import { printJson } from './output.js';

function printHumanResult(result: SetupResult): void {
  const verb = result.dryRun ? 'Would install' : 'Installed';
  console.log(`${verb} connector "${result.agentKey}" → ${result.installPath}`);
  for (const file of result.files) {
    const marker = file.action === 'written' ? '+' : file.action === 'would-write' ? '~' : '=';
    console.log(`  ${marker} ${file.path}${file.executable ? ' (executable)' : ''}`);
  }
  for (const warning of result.warnings) {
    console.log(`  warn: ${warning}`);
  }
}

export async function runSetupCommand({
  rest,
  json
}: {
  rest: string[];
  json: boolean;
}): Promise<void> {
  const parsed = parseArgs(rest);
  const target = parsed.positional[0];
  const dryRun = flagBoolean(parsed.flags, '--dry-run');
  const home = flagValue(parsed.flags, '--home');

  if (!target) {
    const available = listAvailableConnectors();
    if (json) {
      printJson({ available, usage: 'ovld setup <agent>|all [--dry-run] [--json]' });
    } else {
      console.log('Available connectors:');
      for (const agent of available) {
        console.log(`  ${agent}`);
      }
      console.log('');
      console.log('Install one with `ovld setup <agent>` or all with `ovld setup all`.');
    }
    return;
  }

  const results =
    target === 'all'
      ? setupAllConnectors({ home, dryRun })
      : [setupConnector({ agentKey: target, home, dryRun })];

  if (json) {
    printJson({ ok: true, dryRun, results });
  } else {
    for (const result of results) {
      printHumanResult(result);
    }
  }
}
