import { CliError } from './errors.js';

/**
 * Flags accepted by every management/top-level command and therefore never
 * rejected. `--json` is a near-universal output switch; `--help`/`-h` stay
 * accepted so a future per-command help surface (mission coo:273 objective 2)
 * can layer on without this validation blocking it.
 */
const GLOBAL_FLAGS = ['--json', '--help', '-h'] as const;

/** Flags shared by every terminal-launching command (launch/restart/run/connect/resume). */
const LAUNCH_FLAGS = [
  '--agent',
  '--mission-id',
  '--objective-id',
  '--working-directory',
  '--terminal',
  '--no-terminal',
  '--dry-run',
  '--branch',
  '--no-worktree',
  '--model',
  '--thinking',
  '--flag',
  '--pre-command'
] as const;

/**
 * Per-command allowlist of accepted flags, keyed by the top-level `ovld`
 * command token. A command whose token is absent from this map is not
 * validated — most importantly `protocol`, whose subcommand flags are owned by
 * the Protocol Layer and forwarded to the backend for validation, so the CLI
 * must not second-guess them here.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  version: [],
  update: ['--check', '--force', '--no-fund'],
  serve: ['--host', '--port', '--db'],
  init: [],
  doctor: [],
  setup: [],
  'agent-setup': ['--dry-run', '--home'],
  config: ['--path', '--url'],
  auth: ['--token', '--organization-id'],
  'user-token': ['--label', '--expires-in', '--no-expiry', '--scope', '--id'],
  prune: [],
  'create-project': ['--name', '--directory', '--no-directory'],
  'org-setup': [
    '--org-name',
    '--workspace-name',
    '--workspace-slug',
    '--logo',
    '--no-input',
    '--if-needed'
  ],
  'add-cwd': ['--directory', '--key', '--project-id', '--primary'],
  'add-url': ['--url', '--project-id', '--key', '--primary'],
  create: ['--objectives-json', '--objective', '--prompt', '--project-id', '--title', '--resource'],
  prompt: [
    '--objectives-json',
    '--objective',
    '--prompt',
    '--project-id',
    '--title',
    '--resource',
    '--agent'
  ],
  attach: ['--mission-id', '--agent', '--objective-id', '--model', '--thinking'],
  execution: ['--mission-id', '--agent', '--objective-id', '--model', '--thinking'],
  launch: LAUNCH_FLAGS,
  restart: LAUNCH_FLAGS,
  run: LAUNCH_FLAGS,
  connect: LAUNCH_FLAGS,
  resume: LAUNCH_FLAGS,
  runner: [
    '--project-id',
    '--poll-interval-ms',
    '--dry-run',
    '--branch',
    '--no-worktree',
    '--terminal',
    '--no-terminal',
    '--no-start'
  ],
  missions: ['--status', '--query', '--project-id', '--limit'],
  mission: [],
  changes: ['--mission-id', '--objective-id']
};

/** Cheap edit distance for a single "did you mean" suggestion. */
function editDistance(a: string, b: string): number {
  // Single-row DP: prev[j] holds the distance for the previous source char.
  let prev = Array.from({ length: b.length + 1 }, (_unused, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/** Closest allowed flag to an unknown one, when it is a plausible typo. */
function suggestFlag(unknown: string, allowed: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(unknown, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only suggest when it is close enough to be a typo, not an unrelated flag.
  const threshold = Math.max(2, Math.floor(unknown.length / 3));
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/**
 * Reject `--`-prefixed flags a command does not understand, instead of silently
 * ignoring them. Only long (`--`) flags are validated; bare tokens and `-`-style
 * short forms are left to each command's positional handling. Commands absent
 * from {@link COMMAND_FLAGS} (e.g. `protocol`) are skipped entirely.
 */
export function assertKnownFlags({
  command,
  flags,
  primaryCommand
}: {
  command: string;
  flags: Map<string, string | true>;
  primaryCommand: string;
}): void {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return;

  const allowedSet = new Set<string>([...GLOBAL_FLAGS, ...allowed]);
  const unknown = [...flags.keys()].filter(flag => flag.startsWith('--') && !allowedSet.has(flag));
  if (unknown.length === 0) return;

  const suggestionPool = [...GLOBAL_FLAGS, ...allowed];
  const details = unknown
    .map(flag => {
      const suggestion = suggestFlag(flag, suggestionPool);
      return suggestion ? `${flag} (did you mean ${suggestion}?)` : flag;
    })
    .join(', ');

  const label = unknown.length === 1 ? 'Unknown flag' : 'Unknown flags';
  throw new CliError({
    message: `${label} for \`${primaryCommand} ${command}\`: ${details}\nRun \`${primaryCommand} help\` for usage.`
  });
}
