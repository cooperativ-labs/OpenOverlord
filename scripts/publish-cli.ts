/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = path.join(repoRoot, 'cli');
const cliDist = path.join(cliDir, 'dist', 'index.js');

const AUTH_TOKEN_KEYS = ['NPM_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'NODE_AUTH_TOKEN'] as const;

type Args = {
  dryRun: boolean;
  otp: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, otp: null };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--otp':
        args.otp = argv[(i += 1)] ?? fail('Missing value for --otp.');
        break;
      case '--help':
        printHelp();
        process.exit(0);
        return args;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Publish overlord-cli to the public npm registry.

Local publishing requires an npm login session with 2FA enabled on the
maintainer account. Granular access tokens can no longer publish when the
package is configured for "Require two-factor authentication and disallow
tokens".

Usage:
  yarn cli:publish
  yarn cli:publish -- --otp 123456
  yarn cli:publish -- --dry-run

Flags:
  --otp <code>   One-time password from your authenticator app
  --dry-run      Print the resolved publish command without uploading

CI publishing uses npm trusted publishing (OIDC). Configure the trusted
publisher on npmjs.com for this repository's workflow, grant
id-token: write in GitHub Actions, and do not set NPM_TOKEN or
NODE_AUTH_TOKEN in the workflow environment.

See https://docs.npmjs.com/trusted-publishers/
`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function isCiPublish(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

function stripAuthTokens(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of AUTH_TOKEN_KEYS) {
    if (env[key]?.trim()) {
      console.log(`Stripping ${key} from the publish environment.`);
    }
    delete env[key];
  }
  return env;
}

function run(
  command: string,
  commandArgs: string[],
  { cwd = cliDir, env = stripAuthTokens() }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
  console.log(`\n→ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${commandArgs.join(' ')}`);
  }
}

function runCapture(
  command: string,
  commandArgs: string[],
  { cwd = cliDir, env = stripAuthTokens() }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): string | null {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function resolveCliVersion(): string {
  const pkgPath = path.join(cliDir, 'package.json');
  if (!existsSync(pkgPath)) fail(`Could not find ${pkgPath}`);

  try {
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    if (typeof version !== 'string' || version.length === 0) {
      fail('cli/package.json is missing a string version.');
    }
    return version;
  } catch (error) {
    fail(`Could not read cli/package.json version: ${(error as Error).message}`);
  }
}

function ensureBuildOutput(): void {
  if (!existsSync(cliDist)) {
    fail(`Missing ${path.relative(repoRoot, cliDist)}. Run yarn cli:build:prod first.`);
  }
}

function ensureLocalPublisher(): void {
  const npmUser = runCapture('npm', ['whoami']);
  if (!npmUser) {
    fail(
      'npm is not authenticated for interactive publishing. Run `npm login` with a maintainer account that has 2FA enabled, then retry with --otp if prompted.'
    );
  }
  console.log(`npm publisher: ${npmUser}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const version = resolveCliVersion();
  const publishEnv = stripAuthTokens();
  const publishArgs = ['publish', ...(args.otp ? [`--otp=${args.otp}`] : [])];

  ensureBuildOutput();

  console.log(`\nPackage: overlord-cli@${version}`);
  console.log(`Registry: https://registry.npmjs.org/`);

  if (isCiPublish()) {
    console.log('Mode: CI trusted publishing (OIDC)');
  } else {
    console.log('Mode: local interactive publish (2FA)');
    if (!args.dryRun) {
      ensureLocalPublisher();
    }
  }

  if (args.dryRun) {
    console.log('\nDry run enabled; no npm publish was performed.');
    console.log(`Resolved command: npm ${publishArgs.join(' ')}`);
    return;
  }

  run('npm', publishArgs, { env: publishEnv });

  console.log(`\n✔ npm publish complete for overlord-cli@${version}\n`);
}

main();
