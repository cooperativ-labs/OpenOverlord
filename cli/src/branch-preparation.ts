import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type BranchDecision, planMissionBranch, sanitizeBranchName } from './branch-planning.js';
import type { CliRuntime } from './runtime.js';

export type BranchPreparationOptions = {
  missionId: string;
  workingDirectory: string;
  enabled: boolean;
  overrideBranch?: string | null;
  noWorktree?: boolean;
};

export type BranchPreparationResult = {
  workingDirectory: string;
  branchAutomation: BranchAutomationPayload | null;
};

export type BranchAutomationPayload = {
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  action: BranchDecision['action'];
  cycle: number;
};

export type MissionShape = {
  title?: unknown;
  sequenceNumber?: unknown;
  sequence?: unknown;
  projectId?: unknown;
  projectSlug?: unknown;
  project?: { slug?: unknown };
  branch?: {
    name?: unknown;
    status?: unknown;
    baseBranch?: unknown;
    overrideBranch?: unknown;
  } | null;
};

type ProjectShape = {
  id?: unknown;
  slug?: unknown;
};

function runGit(cwd: string, args: string[], options: { optional?: boolean } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024
    }).trim();
  } catch (error) {
    if (options.optional) return '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${message}`, { cause: error });
  }
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function resolveGitRoot(workingDirectory: string): string {
  const root = runGit(workingDirectory, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error(`${workingDirectory} is not inside a git repository.`);
  return path.resolve(root);
}

function defaultBranch(gitRoot: string): string {
  const symbolic = runGit(gitRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    optional: true
  });
  const fromOrigin = symbolic.replace(/^origin\//, '').trim();
  if (fromOrigin) return fromOrigin;
  const local = lines(runGit(gitRoot, ['branch', '--format=%(refname:short)'], { optional: true }));
  if (local.includes('main')) return 'main';
  if (local.includes('master')) return 'master';
  return local[0] ?? 'main';
}

function refExists(gitRoot: string, ref: string): boolean {
  return (
    runGit(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], {
      optional: true
    }) !== '' ||
    runGit(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`], {
      optional: true
    }) !== ''
  );
}

// Resolves the base/parent branch to cut from. The project-configured default
// branch (surfaced on the mission as `branch.baseBranch`) wins when it actually
// exists in this checkout; otherwise we fall back to the repo's git default so a
// stale/misconfigured setting never blocks branch preparation.
function resolveBaseBranch(gitRoot: string, mission: MissionShape): string {
  const configured = mission.branch?.baseBranch;
  if (typeof configured === 'string' && configured.trim()) {
    const base = configured.trim();
    if (refExists(gitRoot, base)) return base;
  }
  return defaultBranch(gitRoot);
}

function currentWorktrees(gitRoot: string): string[] {
  return lines(runGit(gitRoot, ['worktree', 'list', '--porcelain'], { optional: true }))
    .filter(line => line.startsWith('branch '))
    .map(line => line.replace(/^branch refs\/heads\//, '').trim())
    .filter(Boolean);
}

function revParse(gitRoot: string, ref: string): string {
  return runGit(gitRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    optional: true
  }).trim();
}

// The set of commit SHAs on `base`'s first-parent trunk — the linear backbone you
// walk by always following the first parent. Overlord's merge-with-parent flow
// advances the parent with a `--no-ff` merge commit whose SECOND parent is the
// branch tip, so a genuinely merged branch tip is NOT on this trunk; a branch the
// base merely advanced past linearly (e.g. an empty mission branch) stays on it.
function firstParentTrunk(gitRoot: string, base: string): Set<string> {
  return new Set(lines(runGit(gitRoot, ['rev-list', '--first-parent', base], { optional: true })));
}

// Branches genuinely merged into `base`: contained in the base AND off its
// first-parent trunk (they landed via the `--no-ff` merge commit). Plain
// `git branch --merged <base>` lists every branch whose tip is reachable from the
// base — including freshly-cut/empty ones the base advanced past — which would make
// the planner treat the mission's established (but un-merged) branch as merged and
// spin up a new cycle branch for each objective. Filtering to off-trunk tips keeps
// objectives on the same branch until it has actually been merged into its parent.
// Mirrors the webapp's `branchMergedIntoBase` divergence/first-parent rule.
export function computeMergedBranches(gitRoot: string, base: string): string[] {
  const localTrunk = firstParentTrunk(gitRoot, base);
  const remoteTrunk = firstParentTrunk(gitRoot, `origin/${base}`);
  const result: string[] = [];
  const collect = (refArgs: string[], trunk: Set<string>): void => {
    for (const branch of lines(runGit(gitRoot, refArgs, { optional: true }))) {
      const sha = revParse(gitRoot, branch);
      // On the first-parent trunk ⇒ a plain ancestor, not a real merge ⇒ skip.
      if (sha && trunk.has(sha)) continue;
      result.push(branch);
    }
  };
  collect(['branch', '--merged', base, '--format=%(refname:short)'], localTrunk);
  collect(['branch', '-r', '--merged', `origin/${base}`, '--format=%(refname:short)'], remoteTrunk);
  return result;
}

function repoRefs(gitRoot: string, base: string) {
  return {
    local: lines(runGit(gitRoot, ['branch', '--format=%(refname:short)'], { optional: true })),
    remote: lines(
      runGit(gitRoot, ['branch', '-r', '--format=%(refname:short)'], { optional: true })
    ),
    merged: computeMergedBranches(gitRoot, base),
    checkedOut: currentWorktrees(gitRoot)
  };
}

function isDirtyWorktree(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = runGit(worktreePath, ['status', '--porcelain'], { optional: true });
  return status.trim().length > 0;
}

function worktreeBranch(worktreePath: string): string | null {
  const inside = runGit(worktreePath, ['rev-parse', '--is-inside-work-tree'], { optional: true });
  if (inside !== 'true') return null;
  const branch = runGit(worktreePath, ['branch', '--show-current'], { optional: true });
  return branch || null;
}

function readMissionProjectSlug(mission: MissionShape): string | null {
  const slug = mission.project?.slug;
  if (typeof slug === 'string' && slug.trim()) return slug.trim();
  if (typeof mission.projectSlug === 'string' && mission.projectSlug.trim()) {
    return mission.projectSlug.trim();
  }
  return null;
}

export async function resolveMissionProjectSlug({
  runtime,
  mission
}: {
  runtime: CliRuntime;
  mission: MissionShape;
}): Promise<string> {
  const embedded = readMissionProjectSlug(mission);
  if (embedded) return embedded;

  const projectId = typeof mission.projectId === 'string' ? mission.projectId.trim() : '';
  if (projectId) {
    try {
      const projects = (await runtime.backend.get('/api/projects')) as ProjectShape[];
      const project = Array.isArray(projects)
        ? projects.find(candidate => candidate.id === projectId)
        : null;
      if (typeof project?.slug === 'string' && project.slug.trim()) return project.slug.trim();
    } catch {
      // Keep branch preparation best-effort for older or restricted backends.
    }
  }

  return 'project';
}

function recordedMissionBranch(mission: MissionShape): string | null {
  const branch = mission.branch;
  if (!branch || branch.status === 'pending') return null;
  return typeof branch.name === 'string' && branch.name.trim() ? branch.name.trim() : null;
}

// A branch the user pinned in the mission panel to override the planner's default
// (MissionBranchDto.overrideBranch). The explicit `--branch` flag still wins.
function missionOverrideBranch(mission: MissionShape): string | null {
  const override = mission.branch?.overrideBranch;
  return typeof override === 'string' && override.trim() ? override.trim() : null;
}

function missionSequence(mission: MissionShape, missionId: string): number {
  const direct = mission.sequenceNumber ?? mission.sequence;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string') {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const match = missionId.match(/:(\d+)$/);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

function resolveWorktreeRoot(): string {
  const override = process.env.OVERLORD_WORKTREE_ROOT?.trim();
  if (override) return path.resolve(override);
  const home = process.env.OVLD_HOME?.trim() || process.env.OVERLORD_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.ovld'), 'worktrees');
}

function ensureBranchRef(gitRoot: string, decision: BranchDecision): void {
  if (decision.action === 'reuse') return;
  const check = runGit(gitRoot, ['check-ref-format', '--branch', decision.branch], {
    optional: true
  });
  if (!check) throw new Error(`Invalid branch name: ${decision.branch}`);
}

function ensureWorktree(gitRoot: string, decision: BranchDecision): void {
  ensureBranchRef(gitRoot, decision);
  mkdirSync(path.dirname(decision.worktreePath), { recursive: true });

  if (existsSync(decision.worktreePath)) {
    if (!statSync(decision.worktreePath).isDirectory()) {
      throw new Error(`Worktree path exists and is not a directory: ${decision.worktreePath}`);
    }
    const existingBranch = worktreeBranch(decision.worktreePath);
    if (!existingBranch) {
      throw new Error(`Worktree path exists but is not a git worktree: ${decision.worktreePath}`);
    }
    if (existingBranch !== decision.branch) {
      throw new Error(
        `Worktree path is checked out on ${existingBranch}, expected ${decision.branch}: ${decision.worktreePath}`
      );
    }
    if (isDirtyWorktree(decision.worktreePath)) {
      throw new Error(`Worktree has uncommitted changes: ${decision.worktreePath}`);
    }
    return;
  }

  // The worktree directory is gone but git may still hold a stale registration
  // for this path (e.g. it was purged from Settings → Worktrees, or deleted
  // out-of-band). Prune first so re-adding the same path for a follow-on
  // objective succeeds instead of failing with "already registered".
  runGit(gitRoot, ['worktree', 'prune'], { optional: true });

  if (decision.action === 'reuse') {
    runGit(gitRoot, ['worktree', 'add', decision.worktreePath, decision.branch]);
    return;
  }
  runGit(gitRoot, ['worktree', 'add', '-b', decision.branch, decision.worktreePath, decision.from]);
}

export async function prepareMissionBranch({
  runtime,
  options
}: {
  runtime: CliRuntime;
  options: BranchPreparationOptions;
}): Promise<BranchPreparationResult> {
  if (!options.enabled || options.noWorktree) {
    const override = options.overrideBranch?.trim();
    if (override) {
      const gitRoot = resolveGitRoot(options.workingDirectory);
      const branch = sanitizeBranchName(override, override);
      runGit(gitRoot, ['check-ref-format', '--branch', branch]);
      if (!runGit(gitRoot, ['rev-parse', '--verify', branch], { optional: true })) {
        runGit(gitRoot, ['branch', branch]);
      }
      runGit(gitRoot, ['checkout', branch]);
    }
    return { workingDirectory: options.workingDirectory, branchAutomation: null };
  }

  const gitRoot = resolveGitRoot(options.workingDirectory);
  const mission = (await runtime.backend.get(
    `/api/missions/${encodeURIComponent(options.missionId)}`
  )) as MissionShape;
  const base = resolveBaseBranch(gitRoot, mission);
  const refs = repoRefs(gitRoot, base);
  // The explicit `--branch` flag wins; otherwise honor the mission's pinned
  // override (set in the mission panel's branch selector).
  const overrideBranch = options.overrideBranch?.trim() || missionOverrideBranch(mission);
  const projectSlug = await resolveMissionProjectSlug({ runtime, mission });
  const decision = planMissionBranch({
    mission: {
      title: typeof mission.title === 'string' ? mission.title : 'mission',
      sequence: missionSequence(mission, options.missionId)
    },
    project: { slug: projectSlug },
    recordedBranch: recordedMissionBranch(mission),
    base,
    refs,
    worktreeRoot: resolveWorktreeRoot(),
    overrideBranch
  });

  ensureWorktree(gitRoot, decision);
  return {
    workingDirectory: decision.worktreePath,
    branchAutomation: {
      branchName: decision.branch,
      baseBranch: decision.baseBranch,
      worktreePath: decision.worktreePath,
      action: decision.action,
      cycle: decision.cycle
    }
  };
}
