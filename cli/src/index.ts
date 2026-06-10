import { CliError, formatCliError } from './errors.js';
import { printHelp } from './help.js';
import { runVersionCommand } from './version.js';

const MIN_NODE_MAJOR = 20;

function assertSupportedNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new CliError({
      message:
        `Overlord CLI requires Node.js ${MIN_NODE_MAJOR} or newer. Found ${process.version}.`
    });
  }
}

function wantsJsonOutput(args: string[]): boolean {
  return args.includes('--json');
}

function dispatchCommand({
  primaryCommand,
  command,
  args
}: {
  primaryCommand: string;
  command: string | undefined;
  args: string[];
}): void {
  const json = wantsJsonOutput(args);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp({ primaryCommand });
      return;
    case 'version':
    case '--version':
    case '-v':
      runVersionCommand({ json });
      return;
    default:
      throw new CliError({
        message: `Unknown command: ${command}\nRun \`${primaryCommand} help\` for usage.`
      });
  }
}

export async function runCli({
  primaryCommand,
  argv = process.argv.slice(2)
}: {
  primaryCommand: string;
  argv?: string[];
}): Promise<void> {
  assertSupportedNodeVersion();

  const [command, ...rest] = argv;

  try {
    dispatchCommand({ primaryCommand, command, args: rest });
  } catch (error) {
    throw new CliError({ message: formatCliError(error) });
  }
}

export { getCliVersion } from './version.js';
