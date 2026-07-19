import type { EntityChangeDto } from '../../shared/contract.ts';

import { keys } from './queries.ts';
import { invalidateNonEverhourQueries } from './query-invalidation.ts';

type QueryKey = readonly unknown[];

interface QueryInvalidator {
  invalidateQueries(filters?: {
    queryKey?: QueryKey;
    predicate?: (query: { queryKey: QueryKey }) => boolean;
  }): unknown;
}

export type RealtimeInvalidationMode = 'targeted' | 'full';

const BRANCH_FIELDS = new Set([
  'active_branch',
  'branch',
  'branch_override',
  'worktree_preference'
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringOrNull(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function hasBranchField(change: EntityChangeDto): boolean {
  return (
    change.operation === 'delete' || change.changedFields.some(field => BRANCH_FIELDS.has(field))
  );
}

function unique(keysToInvalidate: QueryKey[]): QueryKey[] {
  const seen = new Set<string>();
  return keysToInvalidate.filter(queryKey => {
    const key = JSON.stringify(queryKey);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function invalidate(queryClient: QueryInvalidator, queryKeys: QueryKey[]): void {
  for (const queryKey of unique(queryKeys)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function projectRepositoryPrefix(projectId: string): QueryKey {
  return ['project', projectId, 'repository'] as const;
}

function allProjectScopedQueries(): QueryKey {
  return ['project'] as const;
}

function missionIdFor(change: EntityChangeDto): string | null {
  return stringOrNull(change.missionId);
}

function objectiveIdFor(change: EntityChangeDto): string | null {
  return stringOrNull(change.objectiveId);
}

function projectIdFor(change: EntityChangeDto): string | null {
  return stringOrNull(change.projectId);
}

function missionWorkflowKeys(change: EntityChangeDto): QueryKey[] | null {
  const missionId = missionIdFor(change);
  const projectId = projectIdFor(change);
  if (!missionId || !projectId) return null;

  const queryKeys: QueryKey[] = [
    keys.mission(missionId),
    keys.missions(projectId),
    keys.myMissions
  ];

  if (hasBranchField(change)) {
    queryKeys.push(keys.missionBranches(missionId), keys.worktrees);
  }

  return queryKeys;
}

function routeChange(change: EntityChangeDto): QueryKey[] | null {
  switch (change.entityType) {
    case 'mission': {
      const workflowKeys = missionWorkflowKeys(change);
      if (change.changedFields.includes('project_id')) {
        return workflowKeys
          ? [...workflowKeys, allProjectScopedQueries()]
          : [allProjectScopedQueries(), keys.myMissions];
      }
      return workflowKeys;
    }
    case 'objective': {
      const objectiveId = objectiveIdFor(change);
      if (!objectiveId) return null;
      return missionWorkflowKeys(change);
    }
    case 'mission_event': {
      const missionId = missionIdFor(change);
      if (!missionId) return null;
      return [keys.missionEvents(missionId), keys.missionDeliveries(missionId)];
    }
    case 'delivery': {
      const missionId = missionIdFor(change);
      if (!missionId) return null;
      return [keys.missionDeliveries(missionId)];
    }
    case 'agent_session':
    case 'execution_request': {
      return missionWorkflowKeys(change);
    }
    case 'attachment': {
      const objectiveId = objectiveIdFor(change);
      if (!objectiveId) return null;
      return [keys.objectiveAttachments(objectiveId)];
    }
    case 'project': {
      const projectId = projectIdFor(change);
      if (!projectId) return null;
      return [['workspace'], keys.project(projectId), keys.missions(projectId), keys.myMissions];
    }
    case 'project_resource': {
      const projectId = projectIdFor(change);
      if (!projectId) return null;
      return [
        keys.projectResources(projectId),
        projectRepositoryPrefix(projectId),
        keys.projectExecutionTarget(projectId),
        keys.worktrees
      ];
    }
    case 'target_resource_observation': {
      const projectId = projectIdFor(change);
      if (!projectId) return null;
      return [keys.projectResources(projectId), projectRepositoryPrefix(projectId)];
    }
    case 'mission_branch_observation': {
      const missionId = missionIdFor(change);
      if (!missionId) return null;
      return [keys.mission(missionId), keys.missionBranches(missionId)];
    }
    case 'project_tag': {
      const projectId = projectIdFor(change);
      if (!projectId) return null;
      return [keys.projectTags(projectId), keys.missions(projectId)];
    }
    case 'workspace_status': {
      return [['workspace'] as const, allProjectScopedQueries(), keys.myMissions];
    }
    case 'workspace':
    case 'workspace_user': {
      return [keys.workspaces, keys.meta, keys.profile];
    }
    case 'workspace_invitation': {
      // No workspace id travels on the change record, so invalidate every
      // `['workspace', ...]`-prefixed query (members, invitations, statuses).
      return [keys.workspaces, keys.meta, ['workspace'] as const];
    }
    case 'profile': {
      return [keys.profile, keys.meta];
    }
    case 'user_token': {
      return [keys.userTokens];
    }
    case 'webhook_subscription': {
      return [keys.webhookSubscriptions];
    }
    case 'user_image': {
      return [keys.profile, keys.meta];
    }
    case 'workspace_image': {
      return [keys.workspaces, keys.meta];
    }
    case 'device':
    case 'execution_target':
    case 'workspace_user_execution_target':
    case 'user_execution_target_preference': {
      // `keys.launchSettings()` → `['launch-settings']`, which as an invalidation
      // prefix also matches the workspace-scoped `['launch-settings', workspaceId]`
      // entries (coo:331 Phase 0).
      return [keys.launchSettings(), allProjectScopedQueries()];
    }
    default:
      return null;
  }
}

function isEntityChangeDto(value: unknown): value is EntityChangeDto {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<EntityChangeDto>;
  return (
    typeof change.seq === 'number' &&
    isNonEmptyString(change.entityType) &&
    isNonEmptyString(change.entityId) &&
    isNonEmptyString(change.operation) &&
    Array.isArray(change.changedFields) &&
    change.changedFields.every(field => typeof field === 'string')
  );
}

export function invalidateRealtimeChanges(
  queryClient: QueryInvalidator,
  changes: unknown
): RealtimeInvalidationMode {
  if (!Array.isArray(changes)) {
    invalidateNonEverhourQueries(queryClient);
    return 'full';
  }

  const queryKeys: QueryKey[] = [];
  for (const change of changes) {
    if (!isEntityChangeDto(change)) {
      invalidateNonEverhourQueries(queryClient);
      return 'full';
    }
    const routed = routeChange(change);
    if (!routed) {
      invalidateNonEverhourQueries(queryClient);
      return 'full';
    }
    queryKeys.push(...routed);
  }

  invalidate(queryClient, queryKeys);
  return 'targeted';
}
