// Deterministic per-mission branch/worktree planning for the service layer (webapp).
//
// This is one of Overlord's "Shared Deterministic Algorithms" (see CONTRACT.md):
// the Runner Layer keeps a byte-for-byte-equivalent copy at
// cli/src/branch-planning.ts. Both are pinned to the shared conformance fixture
// contract/branch-planning-vectors.json. Do not import the CLI copy across the
// component boundary, and bump the contract version (regenerating the fixture)
// on any behavioral change here.
import path from 'node:path';

export type BranchAutomationAction = 'create' | 'reuse' | 'new_cycle';

export type BranchDecisionInput = {
  mission: { title: string; sequence: number };
  project: { slug: string };
  recordedBranch: string | null;
  base: string;
  refs: { local: string[]; remote: string[]; merged: string[]; checkedOut?: string[] };
  worktreeRoot: string;
  overrideBranch?: string | null;
};

export type BranchDecision =
  | {
      action: 'reuse';
      branch: string;
      worktreePath: string;
      baseBranch: string;
      cycle: number;
    }
  | {
      action: 'create';
      branch: string;
      worktreePath: string;
      baseBranch: string;
      cycle: number;
      from: string;
    }
  | {
      action: 'new_cycle';
      branch: string;
      worktreePath: string;
      baseBranch: string;
      cycle: number;
      from: string;
    };

export type MissionBranchPreviewInput = Pick<
  BranchDecisionInput,
  'mission' | 'project' | 'base' | 'worktreeRoot'
>;

const TITLE_SLUG_MAX = 48;

function stripCombiningMarks(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function slugifyBranchTitle(title: string, fallback: string): string {
  const slug = stripCombiningMarks(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = slug.length > TITLE_SLUG_MAX ? slug.slice(0, TITLE_SLUG_MAX) : slug;
  const boundary = truncated.length === TITLE_SLUG_MAX ? truncated.lastIndexOf('-') : -1;
  const bounded =
    boundary > 0 && boundary >= Math.floor(TITLE_SLUG_MAX * 0.6)
      ? truncated.slice(0, boundary)
      : truncated;
  return bounded.replace(/^-+|-+$/g, '') || fallback;
}

export function sanitizeBranchName(branch: string, fallback: string): string {
  let sanitized = stripCombiningMarks(branch)
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\.\.+/g, '.')
    .replace(/(^|\/)[.-]+/g, '$1')
    .replace(/[~^:?*[\]\s]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/(?:\.lock|[./-]+)$/g, '');

  if (!sanitized || sanitized.startsWith('/') || sanitized.includes('@{')) {
    sanitized = fallback;
  }

  return sanitized || fallback;
}

export function canonicalMissionBranch(mission: { title: string; sequence: number }): string {
  const fallback = `mission-${mission.sequence}`;
  const titleSlug = slugifyBranchTitle(mission.title, fallback);
  return sanitizeBranchName(`${titleSlug}-${mission.sequence}`, fallback);
}

function branchLeaf(branch: string): string {
  return branch.replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '') || 'branch';
}

export function missionWorktreePath({
  worktreeRoot,
  projectSlug,
  branch
}: {
  worktreeRoot: string;
  projectSlug: string;
  branch: string;
}): string {
  return path.join(worktreeRoot, projectSlug || 'project', branchLeaf(branch));
}

function normalizeRemoteRef(ref: string): string {
  return ref
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '');
}

function refSet(refs: string[]): Set<string> {
  return new Set(refs.map(normalizeRemoteRef).filter(Boolean));
}

function highestExistingCycle(baseBranch: string, refs: Set<string>): number {
  let highest = refs.has(baseBranch) ? 1 : 0;
  const escaped = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`);
  for (const ref of refs) {
    const match = ref.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(value)) highest = Math.max(highest, value);
  }
  return highest;
}

function withWorktreeFields(input: BranchDecisionInput, branch: string) {
  const canonicalBranch = canonicalMissionBranch(input.mission);
  const cycleMatch = branch.startsWith(`${canonicalBranch}-`)
    ? Number.parseInt(branch.slice(canonicalBranch.length + 1), 10)
    : 1;
  return {
    branch,
    worktreePath: missionWorktreePath({
      worktreeRoot: input.worktreeRoot,
      projectSlug: input.project.slug,
      branch
    }),
    baseBranch: input.base,
    cycle: Number.isFinite(cycleMatch) && cycleMatch > 1 ? cycleMatch : 1
  };
}

export function planMissionBranch(input: BranchDecisionInput): BranchDecision {
  const baseBranch = canonicalMissionBranch(input.mission);
  const allRefs = refSet([...input.refs.local, ...input.refs.remote]);
  const mergedRefs = refSet(input.refs.merged);
  const checkedOutRefs = refSet(input.refs.checkedOut ?? []);
  const override = input.overrideBranch
    ? sanitizeBranchName(input.overrideBranch, input.overrideBranch)
    : null;

  if (override) {
    const exists = allRefs.has(override);
    return exists
      ? { action: 'reuse', ...withWorktreeFields(input, override) }
      : { action: 'create', ...withWorktreeFields(input, override), from: input.base };
  }

  if (input.recordedBranch) {
    const recorded = normalizeRemoteRef(input.recordedBranch);
    const stillExists = allRefs.has(recorded);
    const merged = mergedRefs.has(recorded) || !stillExists;
    if (!merged) {
      return { action: 'reuse', ...withWorktreeFields(input, recorded) };
    }
  }

  if (!input.recordedBranch) {
    return allRefs.has(baseBranch)
      ? { action: 'reuse', ...withWorktreeFields(input, baseBranch) }
      : { action: 'create', ...withWorktreeFields(input, baseBranch), from: input.base };
  }

  const nextCycle = Math.max(2, highestExistingCycle(baseBranch, allRefs) + 1);
  let candidate = `${baseBranch}-${nextCycle}`;
  let cycle = nextCycle;
  while (allRefs.has(candidate) || checkedOutRefs.has(candidate) || mergedRefs.has(candidate)) {
    cycle += 1;
    candidate = `${baseBranch}-${cycle}`;
  }
  return { action: 'new_cycle', ...withWorktreeFields(input, candidate), from: input.base };
}

export function previewMissionBranch(input: MissionBranchPreviewInput): BranchDecision {
  return planMissionBranch({
    ...input,
    recordedBranch: null,
    refs: { local: [], remote: [], merged: [] }
  });
}
