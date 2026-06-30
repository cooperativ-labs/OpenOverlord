import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { BranchObservationResult } from '../../../packages/core/service/local-target/branch-observe-git.ts';
import type { BranchListResult } from '../../../packages/core/service/local-target/types.ts';
import type {
  BranchActionBody,
  MissionBranchDto,
  MissionBranchListDto,
  MissionBranchStatus,
  MissionDetailDto,
  ProjectDto,
  ProjectResourceDto,
  PurgeWorktreesResultDto,
  RemoveWorktreeBody,
  WorktreeDto
} from '../../shared/contract.ts';

import { ApiRequestError } from './api.ts';
import {
  hasDesktopLocalTargetBridge,
  invokeLocalTarget,
  isLocalTargetCapabilityAvailable,
  useLocalTargetCapabilityAvailable
} from './local-target-client.ts';
import { reportMissionBranchObservation } from './mission-branch-observations.ts';

export {
  useLocalTargetCapabilityAvailable,
  useLocalTargetUnavailable
} from './local-target-client.ts';

type CapabilityFailureDetails = {
  branchActionCode?: string;
  detail?: string;
};

export function throwLocalTargetFailure(result: {
  code: string;
  message: string;
  details?: unknown;
}): never {
  const details = result.details as CapabilityFailureDetails | undefined;
  const code = details?.branchActionCode ?? result.code;
  throw new ApiRequestError(result.message, 409, code, details?.detail);
}

export function resolvePrimaryResourceForTarget({
  resources,
  executionTargetId
}: {
  resources: ProjectResourceDto[];
  executionTargetId: string | null;
}): ProjectResourceDto | null {
  const active = resources.filter(
    resource => resource.status === 'active' && resource.type === 'local_directory'
  );
  if (active.length === 0) return null;

  const forTarget =
    executionTargetId === null
      ? active
      : active.filter(
          resource =>
            resource.executionTargetId === executionTargetId || resource.executionTargetId === null
        );
  if (forTarget.length === 0) return null;

  return (
    forTarget.find(resource => resource.isPrimary) ??
    forTarget.find(resource => resource.executionTargetId === executionTargetId) ??
    forTarget[0] ??
    null
  );
}

export interface ClientBranchActionContext {
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  primaryRepoPath: string;
}

export async function resolveClientBranchActionContext({
  mission,
  resources,
  executionTargetId
}: {
  mission: MissionDetailDto;
  resources: ProjectResourceDto[];
  executionTargetId: string | null;
}): Promise<ClientBranchActionContext | null> {
  const branch = mission.branch;
  if (!branch?.name || branch.status === 'pending') return null;

  const resource = resolvePrimaryResourceForTarget({ resources, executionTargetId });
  if (!resource?.path) return null;

  const baseBranch = branch.baseBranch ?? 'main';
  let worktreePath = branch.worktreePath;

  if (await isLocalTargetCapabilityAvailable()) {
    const observed = await invokeLocalTarget<BranchObservationResult>({
      capability: 'deriveBranchStatus',
      input: {
        repoPath: resource.path,
        branchName: branch.name,
        baseBranch,
        worktreePathHint: branch.worktreePath
      }
    });
    if (observed.ok && observed.value.worktreePath) {
      worktreePath = observed.value.worktreePath;
    }
  }

  if (!worktreePath) return null;

  return {
    branchName: branch.name,
    baseBranch,
    worktreePath,
    primaryRepoPath: resource.path
  };
}

export async function fetchMissionBranchesFromLocalTarget({
  resource,
  current
}: {
  resource: ProjectResourceDto;
  current: string | null;
}): Promise<MissionBranchListDto> {
  const result = await invokeLocalTarget<BranchListResult>({
    capability: 'listBranches',
    input: { resourceId: resource.id, repoPath: resource.path }
  });
  if (!result.ok) {
    return { branches: current ? [current] : [], current };
  }
  const names = new Set<string>();
  for (const name of [...result.value.local, ...result.value.remote]) names.add(name);
  if (current) names.add(current);
  return { branches: [...names].sort((a, b) => a.localeCompare(b)), current };
}

export async function observeMissionBranchFromLocalTarget({
  branch,
  resource
}: {
  branch: MissionBranchDto;
  resource: ProjectResourceDto;
}): Promise<MissionBranchDto> {
  if (branch.status === 'pending') return branch;

  const result = await invokeLocalTarget<BranchObservationResult>({
    capability: 'deriveBranchStatus',
    input: {
      repoPath: resource.path,
      branchName: branch.name,
      baseBranch: branch.baseBranch,
      worktreePathHint: branch.worktreePath
    }
  });

  if (!result.ok) return branch;

  return {
    ...branch,
    status: result.value.status as MissionBranchStatus,
    dirty: result.value.dirty,
    worktreePath: result.value.worktreePath ?? branch.worktreePath,
    observedAt: new Date().toISOString(),
    observationSource: 'client'
  };
}

export async function fetchWorktreesFromLocalTarget({
  projects,
  projectResources
}: {
  projects: ProjectDto[];
  projectResources: Map<string, ProjectResourceDto[]>;
}): Promise<WorktreeDto[]> {
  const projectInputs: Array<{
    project: ProjectDto;
    primaryRepoPath: string;
  }> = [];

  for (const project of projects) {
    const resources = projectResources.get(project.id) ?? [];
    const primary = resolvePrimaryResourceForTarget({ resources, executionTargetId: null });
    if (!primary?.path) continue;
    projectInputs.push({ project, primaryRepoPath: primary.path });
  }

  const listed = await invokeLocalTarget<{
    worktrees: Array<{
      path: string;
      branch: string | null;
      primaryRepoPath: string;
      dirty: boolean;
    }>;
  }>({
    capability: 'listWorktrees',
    input: {
      worktreeRoot: '',
      projects: projectInputs.map(input => ({ primaryRepoPath: input.primaryRepoPath }))
    }
  });

  if (!listed.ok) return [];

  const dtos: WorktreeDto[] = [];
  for (const worktree of listed.value.worktrees) {
    const project =
      projectInputs.find(input => input.primaryRepoPath === worktree.primaryRepoPath)?.project ??
      projectInputs[0]?.project;
    if (!project) continue;

    let status: MissionBranchStatus | null = null;
    if (worktree.branch) {
      const observed = await invokeLocalTarget<BranchObservationResult>({
        capability: 'deriveBranchStatus',
        input: {
          repoPath: worktree.primaryRepoPath,
          branchName: worktree.branch,
          baseBranch: null,
          worktreePathHint: worktree.path
        }
      });
      if (observed.ok) {
        status = observed.value.status as MissionBranchStatus;
      }
    }

    dtos.push({
      path: worktree.path,
      branch: worktree.branch,
      projectId: project.id,
      projectName: project.name,
      missionId: null,
      missionDisplayId: null,
      status,
      merged: status === 'merged' || status === 'merged_unpushed',
      dirty: worktree.dirty,
      sizeBytes: null,
      lastModifiedAt: null
    });
  }

  return dtos.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runBranchActionOnLocalTarget({
  context,
  body
}: {
  context: ClientBranchActionContext;
  body: BranchActionBody;
}): Promise<string> {
  const result = await invokeLocalTarget<{ summary: string }>({
    capability: 'performBranchAction',
    input: {
      action: body.action,
      branchName: context.branchName,
      baseBranch: context.baseBranch,
      worktreePath: context.worktreePath,
      primaryRepoPath: context.primaryRepoPath,
      message: body.message
    }
  });
  if (!result.ok) throwLocalTargetFailure(result);
  return result.value.summary;
}

export async function gatherCommitDiffOnLocalTarget({
  worktreePath
}: {
  worktreePath: string;
}): Promise<string> {
  const result = await invokeLocalTarget<{ diff: string }>({
    capability: 'generateCommitMessageFromLocalDiff',
    input: { worktreePath }
  });
  if (!result.ok) throwLocalTargetFailure(result);
  return result.value.diff;
}

export async function removeWorktreeOnLocalTarget({
  body,
  projects,
  projectResources
}: {
  body: RemoveWorktreeBody;
  projects: ProjectDto[];
  projectResources: Map<string, ProjectResourceDto[]>;
}): Promise<PurgeWorktreesResultDto> {
  const primaryRepoPath = body.primaryRepoPath?.trim();
  if (!primaryRepoPath) {
    throw new ApiRequestError(
      'A primary repository path is required to remove a worktree locally.',
      400
    );
  }

  const result = await invokeLocalTarget<PurgeWorktreesResultDto>({
    capability: 'removeWorktree',
    input: {
      path: body.path,
      primaryRepoPath,
      force: body.force ?? false
    }
  });
  if (!result.ok) throwLocalTargetFailure(result);

  return {
    removed: result.value.removed,
    skipped: result.value.skipped,
    worktrees: await fetchWorktreesFromLocalTarget({ projects, projectResources })
  };
}

export async function purgeMergedWorktreesOnLocalTarget({
  projects,
  projectResources
}: {
  projects: ProjectDto[];
  projectResources: Map<string, ProjectResourceDto[]>;
}): Promise<PurgeWorktreesResultDto> {
  const worktrees = await fetchWorktreesFromLocalTarget({ projects, projectResources });
  const targets = worktrees
    .filter(worktree => worktree.merged && !worktree.dirty)
    .map(worktree => {
      const resources = projectResources.get(worktree.projectId) ?? [];
      const primary = resolvePrimaryResourceForTarget({ resources, executionTargetId: null });
      return primary?.path ? { path: worktree.path, primaryRepoPath: primary.path } : null;
    })
    .filter((entry): entry is { path: string; primaryRepoPath: string } => entry !== null);

  const result = await invokeLocalTarget<PurgeWorktreesResultDto>({
    capability: 'purgeMergedWorktrees',
    input: { entries: targets }
  });
  if (!result.ok) throwLocalTargetFailure(result);

  return {
    removed: result.value.removed,
    skipped: result.value.skipped,
    worktrees: await fetchWorktreesFromLocalTarget({ projects, projectResources })
  };
}

export function useObservedMissionBranch({
  mission,
  resource,
  executionTargetId,
  enabled
}: {
  mission: MissionDetailDto;
  resource: ProjectResourceDto | null;
  executionTargetId: string | null;
  enabled: boolean;
}) {
  const localTargetAvailable = useLocalTargetCapabilityAvailable();
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: [
      'observed-mission-branch',
      mission.id,
      resource?.id,
      resource?.path,
      executionTargetId,
      mission.branch?.name,
      mission.branch?.status
    ],
    queryFn: async () => {
      if (!mission.branch || !resource) return mission.branch;
      const observed = await observeMissionBranchFromLocalTarget({
        branch: mission.branch,
        resource
      });
      if (executionTargetId && observed.observationSource === 'client') {
        const recorded = await reportMissionBranchObservation({
          executionTargetId,
          missionId: mission.id,
          branch: observed
        });
        if (recorded > 0) {
          await queryClient.invalidateQueries({ queryKey: ['mission', mission.id] });
        }
      }
      return observed;
    },
    enabled: enabled && localTargetAvailable && Boolean(mission.branch && resource),
    staleTime: 5_000
  });
}
