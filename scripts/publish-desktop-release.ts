/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopReleaseDir = path.join(repoRoot, 'desktop', 'release');

type Args = {
  dryRun: boolean;
  draft: boolean;
  notes: string | null;
  notesFile: string | null;
  prerelease: boolean;
  releaseDir: string;
  repo: string | null;
  tag: string | null;
  target: string | null;
  title: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    draft: false,
    notes: null,
    notesFile: null,
    prerelease: false,
    releaseDir: desktopReleaseDir,
    repo: null,
    tag: null,
    target: null,
    title: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--draft':
        args.draft = true;
        break;
      case '--notes':
        args.notes = argv[(i += 1)] ?? fail('Missing value for --notes.');
        break;
      case '--notes-file':
        args.notesFile = argv[(i += 1)] ?? fail('Missing value for --notes-file.');
        break;
      case '--prerelease':
        args.prerelease = true;
        break;
      case '--release-dir':
        args.releaseDir = path.resolve(argv[(i += 1)] ?? fail('Missing value for --release-dir.'));
        break;
      case '--repo':
        args.repo = argv[(i += 1)] ?? fail('Missing value for --repo.');
        break;
      case '--tag':
        args.tag = argv[(i += 1)] ?? fail('Missing value for --tag.');
        break;
      case '--target':
        args.target = argv[(i += 1)] ?? fail('Missing value for --target.');
        break;
      case '--title':
        args.title = argv[(i += 1)] ?? fail('Missing value for --title.');
        break;
      case '--help':
        printHelp();
        process.exit(0);
        return;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  if (args.notes && args.notesFile) {
    fail('Pass at most one of --notes or --notes-file.');
  }

  return args;
}

function printHelp(): void {
  console.log(`Publish desktop artifacts from desktop/release to GitHub Releases.

Usage:
  yarn desktop:publish [--tag v1.2.3] [--repo owner/name] [--draft] [--prerelease]
  yarn desktop:publish --notes-file ./release-notes.md
  yarn desktop:publish --dry-run

Flags:
  --release-dir <dir>  Directory to scan for desktop artifacts (default: desktop/release)
  --repo <owner/name>  GitHub repo to publish to (default: inferred from origin)
  --tag <tag>          Release tag to create/upload to (default: v<root package version>)
  --title <title>      Release title when creating a new release
  --notes <text>       Inline release notes when creating a new release
  --notes-file <path>  Release notes file when creating a new release
  --target <ref>       Target branch or commit when creating a new release
  --draft              Create the release as a draft
  --prerelease         Mark the release as a prerelease
  --dry-run            Print the resolved release command and assets without calling GitHub
`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(command: string, commandArgs: string[], cwd = repoRoot): void {
  console.log(`\n→ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${commandArgs.join(' ')}`);
  }
}

function runCapture(command: string, commandArgs: string[], cwd = repoRoot): string | null {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function resolvePackageVersion(): string {
  const pkg = path.join(repoRoot, 'package.json');
  if (!existsSync(pkg)) fail(`Could not find ${pkg}`);
  try {
    const version = JSON.parse(readFileSync(pkg, 'utf8')).version;
    if (typeof version !== 'string' || version.length === 0) {
      fail('Root package.json is missing a string version.');
    }
    return version;
  } catch (error) {
    fail(`Could not read root package.json version: ${(error as Error).message}`);
  }
}

function resolveRepo(explicitRepo: string | null): string {
  if (explicitRepo) return explicitRepo;

  const remote = runCapture('git', ['remote', 'get-url', 'origin']);
  if (!remote) fail('Could not resolve git origin. Pass --repo owner/name.');

  const match = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote);
  if (!match) fail(`Could not infer GitHub repo from origin URL: ${remote}`);
  return match[1];
}

function ensureGhAvailable(): void {
  const version = runCapture('gh', ['--version']);
  if (!version) fail('GitHub CLI (`gh`) is required. Install it and authenticate first.');
}

function collectAssets(releaseDir: string, version: string): string[] {
  if (!existsSync(releaseDir)) fail(`Release directory does not exist: ${releaseDir}`);

  const assets = readdirSync(releaseDir)
    .filter(name => {
      const fullPath = path.join(releaseDir, name);
      if (!statSync(fullPath).isFile()) return false;
      if (name === 'latest-mac.yml') return true;
      if (!/\.(dmg|zip|blockmap|AppImage|deb)$/.test(name)) return false;
      return name.includes(version);
    })
    .sort()
    .map(name => path.join(releaseDir, name));

  if (assets.length === 0) {
    fail(`No release assets for version ${version} found in ${releaseDir}`);
  }

  if (!assets.some(asset => asset.endsWith('.dmg'))) {
    fail(`No .dmg artifact found in ${releaseDir}`);
  }

  return assets;
}

function releaseExists(tag: string, repo: string): boolean {
  const result = spawnSync('gh', ['release', 'view', tag, '--repo', repo], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: process.env
  });
  return result.status === 0;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const version = resolvePackageVersion();
  const tag = args.tag ?? `v${version}`;
  const title = args.title ?? `Overlord ${tag}`;
  const repo = resolveRepo(args.repo);
  const assets = collectAssets(args.releaseDir, version);

  ensureGhAvailable();

  const exists = args.dryRun ? false : releaseExists(tag, repo);
  const commandArgs = exists
    ? ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber']
    : [
        'release',
        'create',
        tag,
        ...assets,
        '--repo',
        repo,
        '--title',
        title,
        ...(args.target ? ['--target', args.target] : []),
        ...(args.draft ? ['--draft'] : []),
        ...(args.prerelease ? ['--prerelease'] : []),
        ...(args.notes ? ['--notes', args.notes] : []),
        ...(args.notesFile ? ['--notes-file', path.resolve(args.notesFile)] : []),
        ...(!args.notes && !args.notesFile ? ['--generate-notes'] : [])
      ];

  console.log(`\nRelease repo: ${repo}`);
  console.log(`Release tag: ${tag}`);
  console.log(`Release dir: ${args.releaseDir}`);
  console.log(`Assets:`);
  for (const asset of assets) {
    console.log(`  - ${path.relative(repoRoot, asset)}`);
  }

  if (args.dryRun) {
    console.log('\nDry run enabled; no GitHub release changes were made.');
    console.log(`Resolved command: gh ${commandArgs.join(' ')}`);
    return;
  }

  if (exists) {
    console.log(`\nRelease ${tag} already exists; uploading assets with --clobber.`);
  } else {
    console.log(`\nRelease ${tag} does not exist; creating it now.`);
  }

  run('gh', commandArgs);

  console.log(`\n✔ GitHub release publish complete for ${tag}\n`);
}

main();
