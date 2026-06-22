import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type BranchDecision, planTicketBranch, sanitizeBranchName } from './branch-planning.js';
import type { CliRuntime } from './runtime.js';

export type BranchPreparationOptions = {
  ticketId: string;
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

type TicketShape = {
  title?: unknown;
  sequenceNumber?: unknown;
  sequence?: unknown;
  project?: { slug?: unknown };
  branch?: {
    name?: unknown;
    status?: unknown;
  } | null;
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

function currentWorktrees(gitRoot: string): string[] {
  return lines(runGit(gitRoot, ['worktree', 'list', '--porcelain'], { optional: true }))
    .filter(line => line.startsWith('branch '))
    .map(line => line.replace(/^branch refs\/heads\//, '').trim())
    .filter(Boolean);
}

function repoRefs(gitRoot: string, base: string) {
  return {
    local: lines(runGit(gitRoot, ['branch', '--format=%(refname:short)'], { optional: true })),
    remote: lines(
      runGit(gitRoot, ['branch', '-r', '--format=%(refname:short)'], { optional: true })
    ),
    merged: [
      ...lines(
        runGit(gitRoot, ['branch', '--merged', base, '--format=%(refname:short)'], {
          optional: true
        })
      ),
      ...lines(
        runGit(
          gitRoot,
          ['branch', '-r', '--merged', `origin/${base}`, '--format=%(refname:short)'],
          {
            optional: true
          }
        )
      )
    ],
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

function ticketProjectSlug(ticket: TicketShape): string {
  const slug = ticket.project?.slug;
  if (typeof slug === 'string' && slug.trim()) return slug.trim();
  return 'project';
}

function recordedTicketBranch(ticket: TicketShape): string | null {
  const branch = ticket.branch;
  if (!branch || branch.status === 'pending') return null;
  return typeof branch.name === 'string' && branch.name.trim() ? branch.name.trim() : null;
}

function ticketSequence(ticket: TicketShape, ticketId: string): number {
  const direct = ticket.sequenceNumber ?? ticket.sequence;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string') {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const match = ticketId.match(/:(\d+)$/);
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

  if (decision.action === 'reuse') {
    runGit(gitRoot, ['worktree', 'add', decision.worktreePath, decision.branch]);
    return;
  }
  runGit(gitRoot, ['worktree', 'add', '-b', decision.branch, decision.worktreePath, decision.from]);
}

export async function prepareTicketBranch({
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
  const ticket = (await runtime.backend.get(
    `/api/tickets/${encodeURIComponent(options.ticketId)}`
  )) as TicketShape;
  const base = defaultBranch(gitRoot);
  const refs = repoRefs(gitRoot, base);
  const decision = planTicketBranch({
    ticket: {
      title: typeof ticket.title === 'string' ? ticket.title : 'ticket',
      sequence: ticketSequence(ticket, options.ticketId)
    },
    project: { slug: ticketProjectSlug(ticket) },
    recordedBranch: recordedTicketBranch(ticket),
    base,
    refs,
    worktreeRoot: resolveWorktreeRoot(),
    overrideBranch: options.overrideBranch
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
