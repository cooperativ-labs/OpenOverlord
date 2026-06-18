/**
 * Build, sign, and notarize the Overlord desktop app, emitting the artifacts to
 * a folder the operator specifies.
 *
 *   yarn desktop:package                                          # signed → desktop/release (for publish)
 *   yarn desktop:package --out ~/Desktop/overlord-dist            # signed (auto-discovered identity)
 *   yarn desktop:package --out ~/Desktop/overlord-dist --notarize # signed + notarized
 *   yarn desktop:package --out ./build --no-sign                  # ad-hoc, no Apple account
 *
 * Flags:
 *   --out <dir>            where the .dmg/.zip are copied (default: desktop/release)
 *   --arch <arm64|x64|universal>   (default: host arch)
 *   --no-sign              ad-hoc build (Gatekeeper warns; fine for local testing)
 *   --sign                 sign with the Developer ID Application identity (default)
 *   --notarize             implies --sign; notarize + staple via notarytool
 *
 * Signing/notarization credentials come from the environment (the repo `.env`):
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 *   (and optionally CSC_LINK / CSC_KEY_PASSWORD for an explicit .p12 identity).
 *
 * Inputs are just our existing module outputs: the script builds them, bundles
 * the server, stages the SPA + CLI, then runs electron-builder.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_UPDATE_FEED_URL } from '../desktop/update-feed.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'desktop');
const defaultOutDir = path.join(desktopDir, 'release');

type Args = {
  out: string | null;
  arch: 'arm64' | 'x64' | 'universal';
  sign: boolean;
  notarize: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: null,
    arch: (process.arch === 'arm64' ? 'arm64' : 'x64') as Args['arch'],
    sign: true,
    notarize: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--out':
        args.out = argv[(i += 1)] ?? fail('Missing value for --out.');
        break;
      case '--arch': {
        const value = argv[(i += 1)];
        if (value !== 'arm64' && value !== 'x64' && value !== 'universal') {
          fail(`--arch must be arm64, x64, or universal (got ${value ?? '<missing>'})`);
        }
        args.arch = value;
        break;
      }
      case '--no-sign':
        args.sign = false;
        break;
      case '--sign':
        args.sign = true;
        break;
      case '--notarize':
        args.notarize = true;
        args.sign = true;
        break;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }
  if (!args.out) args.out = defaultOutDir;
  return args;
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Minimal `.env` loader so the script is headless without extra deps. */
function loadEnv(): void {
  const envPath = path.join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;
    if (process.env[key]) continue; // never override an existing env var
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

function run(command: string, commandArgs: string[], cwd = repoRoot): void {
  console.log(`\n→ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    fail(`Command failed (${result.status}): ${command} ${commandArgs.join(' ')}`);
  }
}

function resolveBin(name: string): string {
  for (const dir of [
    path.join(desktopDir, 'node_modules', '.bin'),
    path.join(repoRoot, 'node_modules', '.bin')
  ]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  fail(`Could not find ${name}. Run \`yarn desktop:install\` first.`);
}

function canImportDistutils(python: string): boolean {
  const result = spawnSync(python, ['-c', 'import distutils.version'], {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  return result.status === 0;
}

function resolveCommand(commandName: string): string | null {
  const result = spawnSync('which', [commandName], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function configureNodeGypPython(): void {
  if (process.env.PYTHON) return;

  for (const candidate of ['python3', 'python']) {
    const resolved = resolveCommand(candidate);
    if (resolved && canImportDistutils(resolved)) return;
  }

  for (const candidate of ['python3.11', 'python3.10', 'python3.9', 'python3.8']) {
    const resolved = resolveCommand(candidate);
    if (!resolved || !canImportDistutils(resolved)) continue;
    process.env.PYTHON = resolved;
    console.log(`\n→ Using ${resolved} for node-gyp (default Python has no distutils)`);
    return;
  }

  fail(
    'Electron native rebuild needs a Python with distutils. Set PYTHON to Python 3.11 or install setuptools for your default Python.'
  );
}

function stage(from: string, to: string): void {
  if (!existsSync(from)) fail(`Expected build output missing: ${from}`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function stageFile(from: string, to: string): void {
  if (!existsSync(from)) fail(`Expected build output missing: ${from}`);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}

function resetReleaseDir(): void {
  const releaseDir = path.join(desktopDir, 'release');
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  console.log(`\n→ Cleared ${path.relative(repoRoot, releaseDir)} before packaging`);
}

function main(): void {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  configureNodeGypPython();

  if (!electronInstallDir()) {
    fail(
      'Desktop dependencies are not installed. Run `yarn install` (the desktop workspace pulls Electron) first.'
    );
  }
  ensureElectronBinary();

  if (args.notarize) {
    const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter(
      key => !process.env[key]
    );
    if (missing.length > 0) {
      fail(`--notarize needs ${missing.join(', ')} in the environment (set them in .env).`);
    }
  }

  const tsc = resolveBin('tsc');

  // 1. Build the modules the bundle consumes (existing outputs).
  run('yarn', ['workspace', '@overlord/database', 'build']);
  run('yarn', ['workspace', '@overlord/auth', 'build']);
  run('yarn', ['workspace', '@overlord/automations', 'build']);
  // The CLI is built directly (the root build:cli alias is name-sensitive).
  run(tsc, ['--project', path.join(repoRoot, 'cli', 'tsconfig.build.json')]);
  // SPA + server bundle.
  run('yarn', ['workspace', '@overlord/webapp', 'build']);
  run('yarn', ['workspace', '@overlord/webapp', 'build:server']);
  // Electron main/preload.
  run(process.execPath, [path.join(desktopDir, 'esbuild.mjs')]);

  // 2. Stage assets into the desktop workspace for electron-builder.
  stage(path.join(repoRoot, 'webapp', 'dist-server'), path.join(desktopDir, 'server'));
  stage(path.join(repoRoot, 'webapp', 'dist'), path.join(desktopDir, 'webapp-dist'));
  // The bundled @overlord/database resolves migrations relative to the server
  // bundle (`<dir>/../sqlite/migrations`), i.e. app.asar/sqlite/migrations.
  stage(
    path.join(repoRoot, 'database', 'sqlite', 'migrations'),
    path.join(desktopDir, 'sqlite', 'migrations')
  );
  stageCli();
  stageFile(
    path.join(repoRoot, 'webapp', 'public', 'images', '512.png'),
    path.join(desktopDir, 'build', 'icon.png')
  );

  // Start each package build from a clean electron-builder output directory so
  // stale release artifacts cannot survive into the next run.
  resetReleaseDir();

  // 2b. Rebuild the lone native dependency (better-sqlite3) against the Electron
  // ABI so the packed addon loads at runtime instead of throwing ERR_DLOPEN_FAILED.
  stageNativeAddon(args.arch);

  // 3. Run electron-builder.
  runElectronBuilder(args);

  // 4. Emit artifacts to --out.
  emitArtifacts(args.out!);

  console.log(`\n✔ Desktop build complete → ${path.resolve(args.out!)}\n`);
}

/**
 * Stage the `ovld` CLI next to the app so a future "Install CLI" action and a
 * supervised runner can find it. Ships the bin + compiled dist + the vendored
 * `@overlord/database`. (A fully self-contained Node-ABI native build is a P3
 * follow-up; the GUI itself needs nothing from here.)
 */
function stageCli(): void {
  const cliStaging = path.join(desktopDir, 'staging', 'cli');
  rmSync(cliStaging, { recursive: true, force: true });
  mkdirSync(cliStaging, { recursive: true });
  cpSync(path.join(repoRoot, 'cli', 'bin'), path.join(cliStaging, 'bin'), { recursive: true });
  cpSync(path.join(repoRoot, 'cli', 'dist'), path.join(cliStaging, 'dist'), { recursive: true });
  cpSync(path.join(repoRoot, 'cli', 'package.json'), path.join(cliStaging, 'package.json'));
}

/**
 * Rebuild better-sqlite3 — the app's only native dependency — for the Electron ABI
 * and stage it where electron-builder will pack it.
 *
 * In this yarn-workspace repo, better-sqlite3 is hoisted to the root node_modules
 * and compiled for the *system Node* ABI (yarn builds it against the running node
 * at install time). electron-builder's `npmRebuild` does not rebuild that hoisted
 * copy for the *Electron* ABI, so the packed addon stays Node-ABI and the server's
 * `require('better-sqlite3')` throws ERR_DLOPEN_FAILED at launch — the desktop shell
 * then reports "The Overlord server did not become ready at 127.0.0.1:4310".
 *
 * Fix: stage a desktop-local copy of better-sqlite3 (which shadows the hoisted root
 * one during electron-builder's dependency resolution, so the *packed* addon is
 * Electron-ABI) and drop into it an addon compiled in an isolated temp project. The
 * isolation matters: electron-rebuild rebuilds every copy of the module it finds
 * while walking the workspace dependency tree, so pointing it at the desktop dir
 * would also rebuild the hoisted root copy and break the node-side `ovld` CLI/tests.
 * Building under a throwaway project outside the repo keeps the root copy Node-ABI.
 * The build then fails loudly unless the staged addon loads under the Electron ABI,
 * so a future toolchain change can't silently reintroduce the mismatch.
 */
function stageNativeAddon(arch: Args['arch']): void {
  if (arch === 'universal') {
    fail(
      'Universal native rebuild is not wired up: better-sqlite3 must be built per ' +
        'arch (arm64 + x64) and lipo-merged. Build --arch arm64 and --arch x64 ' +
        'separately, or build for a single arch.'
    );
  }

  const electronVersion = installedElectronVersion();
  if (!electronVersion) {
    fail('Could not determine the installed Electron version for the native rebuild.');
  }

  const src = path.join(repoRoot, 'node_modules', 'better-sqlite3');
  if (!existsSync(src)) {
    fail('better-sqlite3 is not installed at the repo root. Run `yarn install` first.');
  }

  // The copy electron-builder packs: a desktop-local module that shadows the hoisted
  // root one. Its addon is replaced below with the Electron-ABI build.
  const dest = path.join(desktopDir, 'node_modules', 'better-sqlite3');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });

  // Compile the Electron-ABI addon in a throwaway project outside the workspace so
  // electron-rebuild's tree-walk can't also rebuild the hoisted root copy.
  const buildRoot = mkdtempSync(path.join(os.tmpdir(), 'ovld-native-'));
  try {
    const isolated = path.join(buildRoot, 'node_modules', 'better-sqlite3');
    mkdirSync(path.dirname(isolated), { recursive: true });
    cpSync(src, isolated, { recursive: true });
    writeFileSync(
      path.join(buildRoot, 'package.json'),
      JSON.stringify({
        name: 'ovld-native-build',
        private: true,
        dependencies: { 'better-sqlite3': '*' }
      })
    );

    // `--force` is required because the copied build/Release/*.node already exists.
    run(
      resolveBin('electron-rebuild'),
      [
        '--version',
        electronVersion,
        '--arch',
        arch,
        '--module-dir',
        buildRoot,
        '--only',
        'better-sqlite3',
        '--force'
      ],
      buildRoot
    );

    const builtAddon = path.join(isolated, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(builtAddon)) fail(`Native rebuild produced no addon at ${builtAddon}.`);
    const packedAddon = path.join(dest, 'build', 'Release', 'better_sqlite3.node');
    mkdirSync(path.dirname(packedAddon), { recursive: true });
    cpSync(builtAddon, packedAddon);
    assertElectronAbi(packedAddon, electronVersion);
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

/** Fail the build unless `addonPath` loads under the packaged Electron's Node ABI. */
function assertElectronAbi(addonPath: string, electronVersion: string): void {
  if (!existsSync(addonPath)) {
    fail(`Native rebuild produced no addon at ${addonPath}.`);
  }
  // ELECTRON_RUN_AS_NODE runs the Electron binary as plain Node; dlopen of a
  // Node-ABI addon throws ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch).
  const probe = `process.dlopen({ exports: {} }, ${JSON.stringify(addonPath)})`;
  const result = spawnSync(electronExecutable(), ['-e', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  if (result.status !== 0) {
    fail(
      `Staged better-sqlite3 is not built for the Electron ${electronVersion} ABI; ` +
        'the server would fail to start with ERR_DLOPEN_FAILED:\n' +
        `${(result.stderr || result.stdout || '').trim()}`
    );
  }
}

function electronInstallDir(): string | null {
  for (const dir of [desktopDir, repoRoot]) {
    const electronDir = path.join(dir, 'node_modules', 'electron');
    if (existsSync(path.join(electronDir, 'package.json'))) return electronDir;
  }
  return null;
}

/** Absolute path to the installed Electron executable, or null when only the npm wrapper is present. */
function resolveElectronExecutable(): string | null {
  for (const dir of [desktopDir, repoRoot]) {
    const electronDir = path.join(dir, 'node_modules', 'electron');
    const pathTxt = path.join(electronDir, 'path.txt');
    if (!existsSync(pathTxt)) continue;
    const bin = path.join(electronDir, 'dist', readFileSync(pathTxt, 'utf8').trim());
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Download the Electron binary when install was skipped (e.g. ELECTRON_SKIP_BINARY_DOWNLOAD). */
function ensureElectronBinary(): void {
  if (resolveElectronExecutable()) return;

  const electronDir = electronInstallDir();
  if (!electronDir) {
    fail(
      'Desktop dependencies are not installed. Run `yarn install` (the desktop workspace pulls Electron) first.'
    );
  }

  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    fail(
      'Electron binary download was skipped (ELECTRON_SKIP_BINARY_DOWNLOAD=1). ' +
        'Unset it or run `node node_modules/electron/install.js`, then retry `yarn desktop:package`.'
    );
  }

  console.log('\n→ Electron binary not found; downloading via electron/install.js');
  run(process.execPath, [path.join(electronDir, 'install.js')]);

  if (!resolveElectronExecutable()) {
    fail('Electron binary download finished but the executable is still missing.');
  }
}

/** Absolute path to the installed Electron executable (for ELECTRON_RUN_AS_NODE probes). */
function electronExecutable(): string {
  return (
    resolveElectronExecutable() ??
    fail('Could not locate the Electron executable after install. Retry `yarn desktop:package`.')
  );
}

function runElectronBuilder(args: Args): void {
  const builder = resolveBin('electron-builder');
  const builderArgs = ['--mac'];
  if (args.arch === 'universal') builderArgs.push('--universal');
  else builderArgs.push(`--${args.arch}`);

  // electron-builder reads the Electron version from the installed binary; when
  // the binary download was skipped (or the version is a range), pin it
  // explicitly from the installed package metadata.
  const electronVersion = installedElectronVersion();
  if (electronVersion) builderArgs.push(`-c.electronVersion=${electronVersion}`);

  const updateFeedUrl = process.env.OVERLORD_UPDATE_FEED_URL ?? DEFAULT_UPDATE_FEED_URL;
  builderArgs.push('-c.publish.provider=generic');
  builderArgs.push(`-c.publish.url=${updateFeedUrl}`);

  if (args.notarize) {
    builderArgs.push('-c.mac.notarize=true');
  }

  // Ad-hoc when not signing: disable identity auto-discovery so electron-builder
  // does not try to use a Developer ID from the keychain.
  if (!args.sign) {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    builderArgs.push('-c.mac.identity=null');
  }

  run(builder, builderArgs, desktopDir);
}

function installedElectronVersion(): string | null {
  for (const dir of [desktopDir, repoRoot]) {
    const pkg = path.join(dir, 'node_modules', 'electron', 'package.json');
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/** Matches the distributable artifacts a build produces (and that a prior build left behind). */
function isDistributable(name: string): boolean {
  return /\.(dmg|zip|blockmap|AppImage|deb)$/.test(name) || name === 'latest-mac.yml';
}

function emitArtifacts(outDir: string): void {
  const releaseDir = path.join(desktopDir, 'release');
  const resolvedOut = path.resolve(outDir);
  mkdirSync(resolvedOut, { recursive: true });

  if (!existsSync(releaseDir)) fail(`electron-builder produced no output at ${releaseDir}`);

  const wanted = readdirSync(releaseDir).filter(isDistributable);
  if (wanted.length === 0) fail(`No distributable artifacts found in ${releaseDir}`);

  // Remove the preceding build's artifacts from the output dir before saving the
  // new ones, so stale versioned .dmg/.zip/.blockmap files don't accumulate or
  // confuse the generic update feed. Only distributable artifacts are touched;
  // anything else the operator keeps in --out is left alone.
  for (const name of readdirSync(resolvedOut).filter(isDistributable)) {
    const stale = path.join(resolvedOut, name);
    if (path.resolve(stale) !== path.resolve(path.join(releaseDir, name))) {
      rmSync(stale, { force: true });
      console.log(`  removed stale ${name}`);
    }
  }

  for (const name of wanted) {
    const source = path.join(releaseDir, name);
    const destination = path.join(resolvedOut, name);
    if (path.resolve(source) !== path.resolve(destination)) {
      cpSync(source, destination);
    }
    console.log(`  emitted ${name}`);
  }
}

main();
