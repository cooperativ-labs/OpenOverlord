import { CliError, formatCliError } from './errors.js';
import { printHelp } from './help.js';
import { runVersionCommand } from './version.js';

const MIN_NODE_MAJOR = 20;

const DB_FREE_COMMANDS = new Set([
  'help',
  '--help',
  '-h',
  'version',
  '--version',
  '-v',
  'update',
  'init',
  'doctor',
  'setup',
  'agent-setup',
  'serve',
  'config',
  'auth',
  'user-token'
]);

const KNOWN_COMMANDS = new Set([
  ...DB_FREE_COMMANDS,
  'protocol',
  'create-project',
  'add-cwd',
  'create',
  'prompt',
  'attach',
  'launch',
  'restart',
  'connect',
  'run',
  'resume',
  'runner',
  'tickets',
  'ticket',
  'changes',
  'execution',
  'config'
]);

function assertSupportedNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new CliError({
      message: `Overlord CLI requires Node.js ${MIN_NODE_MAJOR} or newer. Found ${process.version}.`
    });
  }
}

function wantsJsonOutput(args: string[]): boolean {
  return args.includes('--json');
}

async function dispatchCommand({
  primaryCommand,
  command,
  args,
  stdin
}: {
  primaryCommand: string;
  command: string | undefined;
  args: string[];
  stdin?: string;
}): Promise<void> {
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
      runVersionCommand({ json: wantsJsonOutput(args) });
      return;
    case 'update': {
      const { runUpdateCommand } = await import('./update.js');
      await runUpdateCommand({ rest: args });
      return;
    }
    case 'init':
    case 'doctor':
    case 'setup':
    case 'agent-setup':
    case 'config':
    case 'auth':
    case 'user-token': {
      const { runLocalCommand } = await import('./management.js');
      await runLocalCommand({ command, rest: args });
      return;
    }
    case 'serve': {
      const { runServeCommand } = await import('./serve.js');
      await runServeCommand({ rest: args });
      return;
    }
    case 'protocol': {
      const [subcommand, ...rest] = args;
      if (!subcommand) {
        throw new CliError({ message: 'Usage: ovld protocol <subcommand> [flags]' });
      }
      const { openCliRuntime } = await import('./runtime.js');
      const { runProtocolCommand } = await import('./commands.js');
      const runtime = openCliRuntime();
      try {
        await runProtocolCommand({ runtime, subcommand, args: rest, stdin, primaryCommand });
      } finally {
        runtime.close();
      }
      return;
    }
    default: {
      if (!KNOWN_COMMANDS.has(command)) {
        throw new CliError({
          message: `Unknown command: ${command}\nRun \`${primaryCommand} help\` for usage.`
        });
      }
      const { openCliRuntime } = await import('./runtime.js');
      const { runManagementCommand } = await import('./commands.js');
      const runtime = openCliRuntime();
      try {
        await runManagementCommand({ runtime, command, rest: args });
      } finally {
        runtime.close();
      }
    }
  }
}

export async function runCli({
  primaryCommand,
  argv = process.argv.slice(2),
  stdin
}: {
  primaryCommand: string;
  argv?: string[];
  stdin?: string;
}): Promise<void> {
  assertSupportedNodeVersion();

  const [command, ...rest] = argv;

  try {
    await dispatchCommand({ primaryCommand, command, args: rest, stdin });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError({ message: formatCliError(error) });
  }
}

export { redactSecrets } from './redact-secrets.js';
export { getCliVersion } from './version.js';
