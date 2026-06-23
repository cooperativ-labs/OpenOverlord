import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BranchActionBody,
  CompleteInitialSetupBody,
  CreateMissionBody,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateUserTokenBody,
  CreateWorkspaceBody,
  CreateWorkspaceStatusBody,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  MissionDetailDto,
  MissionDto,
  MyMissionsResponse,
  ObjectiveAttachmentDto,
  ProjectTagDto,
  RemoveWorktreeBody,
  ReorderFutureObjectivesBody,
  ReorderWorkspaceStatusesBody,
  StatusType,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateMissionBody,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectResourceBody,
  UpdateProjectTagBody,
  UpdateTerminalProfileBody,
  UpdateUserTokenBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceStatusBody,
  UpdateWorktreeBranchAutomationBody,
  WorkspaceStatusDto
} from '../../shared/contract.ts';

import { api } from './api.ts';
import { authClient, normalizeLocalUsername, usernameToLocalEmail } from './auth-client.ts';

export const keys = {
  meta: ['meta'] as const,
  profile: ['profile'] as const,
  userTokens: ['user-tokens'] as const,
  workspaces: ['workspaces'] as const,
  workspaceMembers: (id: string) => ['workspace', id, 'members'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  workspaceStatuses: ['workspace', 'statuses'] as const,
  projectResources: (id: string) => ['project', id, 'resources'] as const,
  projectTags: (id: string) => ['project', id, 'tags'] as const,
  projectRepository: (id: string, executionTargetId: string | null) =>
    ['project', id, 'repository', executionTargetId ?? 'primary'] as const,
  missions: (projectId: string) => ['project', projectId, 'missions'] as const,
  myMissions: ['workspace', 'my-missions'] as const,
  mission: (id: string) => ['mission', id] as const,
  missionBranches: (id: string) => ['mission', id, 'branches'] as const,
  worktrees: ['worktrees'] as const,
  missionEvents: (id: string) => ['mission', id, 'events'] as const,
  missionArtifacts: (id: string) => ['mission', id, 'artifacts'] as const,
  missionFileChanges: (id: string) => ['mission', id, 'file-changes'] as const,
  objectiveAttachments: (objectiveId: string) => ['objective', objectiveId, 'attachments'] as const,
  agentCatalog: ['agent-catalog'] as const,
  launchSettings: ['launch-settings'] as const,
  launchPreference: (projectId: string) => ['project', projectId, 'launch-preference'] as const
};

// Realtime invalidation is global, but mutations also invalidate eagerly so the
// originating user sees their change instantly rather than after the next poll.
function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries();
}

// ---- Queries -------------------------------------------------------------

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: api.meta });

export const useProfile = () => useQuery({ queryKey: keys.profile, queryFn: api.getProfile });

export const useUserTokens = () =>
  useQuery({ queryKey: keys.userTokens, queryFn: api.listUserTokens });

export const useWorkspaces = () =>
  useQuery({ queryKey: keys.workspaces, queryFn: api.listWorkspaces });

export const useWorkspaceMembers = (id: string | null) =>
  useQuery({
    queryKey: keys.workspaceMembers(id ?? '__none__'),
    queryFn: () => api.listWorkspaceMembers(id ?? ''),
    enabled: Boolean(id)
  });

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.listProjects });

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) });

export const useWorkspaceStatuses = () =>
  useQuery({
    queryKey: keys.workspaceStatuses,
    queryFn: () => api.listWorkspaceStatuses()
  });

export const useProjectResources = (id: string) =>
  useQuery({ queryKey: keys.projectResources(id), queryFn: () => api.listProjectResources(id) });

export const useProjectTags = (id: string | null) =>
  useQuery({
    queryKey: keys.projectTags(id ?? 'none'),
    queryFn: () => api.listProjectTags(id as string),
    enabled: Boolean(id)
  });

export const useProjectRepository = (id: string, executionTargetId: string | null) =>
  useQuery({
    queryKey: keys.projectRepository(id, executionTargetId),
    queryFn: () => api.getProjectRepository(id, executionTargetId)
  });

export const useMissions = (projectId: string) =>
  useQuery({ queryKey: keys.missions(projectId), queryFn: () => api.listMissions(projectId) });

// The active operator's assigned missions across the selected workspace. The
// global realtime SSE feed invalidates this whenever missions change, and the
// reorder mutation updates it optimistically.
export const useWorkspaceMyMissions = () =>
  useQuery({ queryKey: keys.myMissions, queryFn: () => api.listWorkspaceMyMissions() });

export const useMission = (id: string, options: { refetchBranchState?: boolean } = {}) =>
  useQuery({
    queryKey: keys.mission(id),
    queryFn: () => api.getMission(id),
    // Mission branch metadata is derived from live git state at request time, not
    // persisted database rows, so the SSE feed cannot observe external git
    // changes. Poll only for open detail panels that opt into branch freshness.
    refetchInterval: options.refetchBranchState ? 5_000 : false
  });

// Available branches for the mission's branch selector. Only fetched when the
// selector is opened (callers pass `enabled`) so we don't shell git on every
// mission open.
export const useMissionBranches = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.missionBranches(id),
    queryFn: () => api.listMissionBranches(id),
    enabled,
    staleTime: 30_000
  });

export const useWorktrees = () =>
  useQuery({ queryKey: keys.worktrees, queryFn: () => api.listWorktrees() });

// The global realtime SSE feed invalidates this query whenever the database
// changes — including mission_events written by the CLI/agent in another process
// — so the activity feed updates in real time without bespoke wiring here.
export const useMissionEvents = (id: string) =>
  useQuery({ queryKey: keys.missionEvents(id), queryFn: () => api.listMissionEvents(id) });

export const useMissionArtifacts = (id: string) =>
  useQuery({ queryKey: keys.missionArtifacts(id), queryFn: () => api.listMissionArtifacts(id) });

// Like the activity feed, the global realtime SSE feed invalidates this query
// whenever the database changes — including change_rationales recorded by the
// CLI/agent in another process — so the File Changes section stays current
// without bespoke wiring here.
export const useMissionFileChanges = (id: string) =>
  useQuery({
    queryKey: keys.missionFileChanges(id),
    queryFn: () => api.listMissionFileChanges(id)
  });

// ---- Mutations -----------------------------------------------------------

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileBody) => api.updateProfile(body),
    onSuccess: data => {
      qc.setQueryData(keys.profile, data);
      // The sidebar identity reads from the workspace meta, so refresh it too.
      void qc.invalidateQueries({ queryKey: keys.meta });
    }
  });
}

/**
 * Change the account username through the Auth surface. The username is the
 * local-part of the synthetic `<username>@overlord.local` sign-in email, so this
 * updates both the Better Auth account name and email; the auth→profiles bridge
 * then mirrors the new username into `profiles.handle`.
 */
export function useChangeUsername() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rawUsername: string) => {
      const username = normalizeLocalUsername(rawUsername);
      const named = await authClient.updateUser({ name: username });
      if (named.error) {
        throw new Error(named.error.message ?? 'Failed to update username.');
      }
      const reemailed = await authClient.changeEmail({ newEmail: usernameToLocalEmail(username) });
      if (reemailed.error) {
        throw new Error(reemailed.error.message ?? 'Failed to update username.');
      }
      return username;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.profile });
      void qc.invalidateQueries({ queryKey: keys.meta });
    }
  });
}

/** Change the account password through the Auth surface (requires the current password). */
export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: { currentPassword: string; newPassword: string }) => {
      const result = await authClient.changePassword({
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true
      });
      if (result.error) {
        throw new Error(result.error.message ?? 'Failed to update password.');
      }
    }
  });
}

/**
 * Upload an image to the `user-images` bucket via the core upload service and
 * set it as the operator's avatar in one step. Returns the updated profile.
 */
export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const stored = await api.uploadImage('user-images', file);
      return api.updateProfile({ avatarUrl: stored.url });
    },
    onSuccess: data => {
      qc.setQueryData(keys.profile, data);
      void qc.invalidateQueries({ queryKey: keys.meta });
    }
  });
}

export function useCreateUserToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserTokenBody) => api.createUserToken(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.userTokens })
  });
}

export function useRenameUserToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserTokenBody }) =>
      api.renameUserToken(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.userTokens })
  });
}

export function useRevokeUserToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeUserToken(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.userTokens })
  });
}

export function useUpdateWorktreeBranchAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWorktreeBranchAutomationBody) =>
      api.updateWorktreeBranchAutomation(body),
    onSuccess: data => {
      qc.setQueryData(keys.launchSettings, data);
    }
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompleteInitialSetupBody) => api.completeSetup(body),
    // Setup renames the active workspace and changes its slug, which feed
    // `/api/meta`, the sidebar identity, and future mission identifiers.
    onSuccess: () => invalidateAll(qc)
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceBody) => api.createWorkspace(body),
    // Creating a workspace also makes it active, so the whole cache is stale.
    onSuccess: () => invalidateAll(qc)
  });
}

export function useActivateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.activateWorkspace(id),
    // Switching workspace changes what every scoped query returns.
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWorkspaceBody }) =>
      api.updateWorkspace(id, body),
    // Renaming the active workspace also changes the sidebar identity (meta).
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    // Deleting may switch the active workspace, so the whole cache is stale.
    onSuccess: () => invalidateAll(qc)
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectBody) => api.createProject(body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectBody) => api.updateProject(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useCreateWorkspaceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceStatusBody) => api.createWorkspaceStatus(body),
    onSuccess: data => {
      qc.setQueryData(keys.workspaceStatuses, (prev: WorkspaceStatusDto[] | undefined) =>
        prev ? [...prev, data].sort((a, b) => a.position - b.position) : [data]
      );
      void qc.invalidateQueries({ queryKey: keys.workspaceStatuses });
    }
  });
}

export function useUpdateWorkspaceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statusId, body }: { statusId: string; body: UpdateWorkspaceStatusBody }) =>
      api.updateWorkspaceStatus(statusId, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteWorkspaceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statusId: string) => api.deleteWorkspaceStatus(statusId),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useReorderWorkspaceStatuses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReorderWorkspaceStatusesBody) => api.reorderWorkspaceStatuses(body),
    onSuccess: data => {
      qc.setQueryData(keys.workspaceStatuses, data);
      void qc.invalidateQueries({ queryKey: keys.workspaceStatuses });
    }
  });
}

export function useCreateProjectTag(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectTagBody) => api.createProjectTag(projectId, body),
    onSuccess: data => {
      qc.setQueryData(keys.projectTags(projectId), (prev: ProjectTagDto[] | undefined) =>
        prev ? [...prev, data].sort((a, b) => a.label.localeCompare(b.label)) : [data]
      );
      void qc.invalidateQueries({ queryKey: keys.projectTags(projectId) });
    }
  });
}

export function useCreateProjectResource(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectResourceBody) => api.createProjectResource(projectId, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateProjectResource(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ resourceId, body }: { resourceId: string; body: UpdateProjectResourceBody }) =>
      api.updateProjectResource(projectId, resourceId, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteProjectResource(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (resourceId: string) => api.deleteProjectResource(projectId, resourceId),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateProjectTag(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, body }: { tagId: string; body: UpdateProjectTagBody }) =>
      api.updateProjectTag(projectId, tagId, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteProjectTag(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => api.deleteProjectTag(projectId, tagId),
    onSuccess: () => invalidateAll(qc)
  });
}

/** Restores an archived project. Takes the project id per call so list rows can share one hook. */
export function useUnarchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.updateProject(id, { status: 'active' }),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useCreateMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMissionBody) => api.createMission(body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateMission(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMissionBody) => api.updateMission(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMission(id),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useGenerateMissionTitle(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.generateMissionTitle(id),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useGenerateCommitMessage(id: string) {
  // Drafts a commit message from the worktree diff. Persists nothing, so there
  // is no cache to invalidate — the caller drops the result into the field.
  return useMutation({
    mutationFn: () => api.generateCommitMessage(id)
  });
}

export function useBranchAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BranchActionBody) => api.branchAction(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RemoveWorktreeBody) => api.removeWorktree(body),
    onSuccess: result => {
      qc.setQueryData(keys.worktrees, result.worktrees);
      void qc.invalidateQueries({ queryKey: keys.worktrees });
    }
  });
}

export function usePurgeMergedWorktrees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.purgeMergedWorktrees(),
    onSuccess: result => {
      qc.setQueryData(keys.worktrees, result.worktrees);
      void qc.invalidateQueries({ queryKey: keys.worktrees });
    }
  });
}

export interface ReorderBoardColumnVars {
  projectId: string;
  /** Destination column / status. */
  statusId: string;
  /** Destination column's semantic type — used only for the optimistic patch. */
  statusType: StatusType;
  /** Every mission id that should occupy the column, top-to-bottom, after the move. */
  orderedMissionIds: string[];
}

/** Mirrors the server's board order: board_position ASC, sequence_number DESC. */
function byBoardOrder(a: MissionDto, b: MissionDto): number {
  if (a.boardPosition !== b.boardPosition) return a.boardPosition - b.boardPosition;
  return b.sequenceNumber - a.sequenceNumber;
}

/**
 * Reorders a board column with an optimistic cache update: the new order/status
 * shows instantly and is reverted only if the server rejects the change. The
 * realtime SSE feed reconciles the cache with server truth on success.
 */
export function useReorderBoardColumn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, statusId, orderedMissionIds }: ReorderBoardColumnVars) =>
      api.reorderBoardColumn(projectId, { statusId, orderedMissionIds }),
    onMutate: async (vars: ReorderBoardColumnVars) => {
      await qc.cancelQueries({ queryKey: keys.missions(vars.projectId) });
      const previous = qc.getQueryData<MissionDto[]>(keys.missions(vars.projectId));
      if (previous) {
        const positionById = new Map(
          vars.orderedMissionIds.map((id, index) => [id, (index + 1) * 100])
        );
        const next = previous
          .map(mission => {
            const position = positionById.get(mission.id);
            return position === undefined
              ? mission
              : {
                  ...mission,
                  statusId: vars.statusId,
                  statusType: vars.statusType,
                  boardPosition: position
                };
          })
          .sort(byBoardOrder);
        qc.setQueryData(keys.missions(vars.projectId), next);
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.missions(vars.projectId), context.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: keys.missions(vars.projectId) });
    }
  });
}

export interface ReorderMyMissionsVars {
  /** Destination column / status. */
  statusId: string;
  /** Destination column's semantic type — used only for the optimistic patch. */
  statusType: StatusType;
  /** Every mission id that should occupy the column, top-to-bottom, after the move. */
  orderedMissionIds: string[];
}

/**
 * Reorders one My Missions status column with an optimistic cache update. Within-
 * column drags only move the personal slot; a cross-column drag also flips the
 * moved mission's status. On error (e.g. a status the workspace lacks) the caller
 * reverts and surfaces the typed alert; here we just roll the cache back.
 */
export function useReorderMyMissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statusId, orderedMissionIds }: ReorderMyMissionsVars) =>
      api.reorderWorkspaceMyMissions({ statusId, orderedMissionIds }),
    onMutate: async (vars: ReorderMyMissionsVars) => {
      await qc.cancelQueries({ queryKey: keys.myMissions });
      const previous = qc.getQueryData<MyMissionsResponse>(keys.myMissions);
      if (previous) {
        const positionById = new Map(
          vars.orderedMissionIds.map((id, index) => [id, (index + 1) * 100])
        );
        qc.setQueryData<MyMissionsResponse>(keys.myMissions, {
          missions: previous.missions.map(mission => {
            const position = positionById.get(mission.id);
            return position === undefined
              ? mission
              : {
                  ...mission,
                  statusId: vars.statusId,
                  statusType: vars.statusType,
                  myPosition: position
                };
          })
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(keys.myMissions, context.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.myMissions });
    }
  });
}

export function useCreateObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateObjectiveBody) => api.createObjective(body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateObjectiveBody }) =>
      api.updateObjective(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteObjective(id),
    onSuccess: () => invalidateAll(qc)
  });
}

// ---- Objective attachments -----------------------------------------------

export const useObjectiveAttachments = (objectiveId: string) =>
  useQuery({
    queryKey: keys.objectiveAttachments(objectiveId),
    queryFn: () => api.listObjectiveAttachments(objectiveId)
  });

export function useUploadObjectiveAttachment(objectiveId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.uploadObjectiveAttachment(objectiveId, file),
    onSuccess: attachment => {
      qc.setQueryData<ObjectiveAttachmentDto[]>(keys.objectiveAttachments(objectiveId), prev =>
        prev ? [...prev, attachment] : [attachment]
      );
      void qc.invalidateQueries({ queryKey: keys.objectiveAttachments(objectiveId) });
    }
  });
}

export function useDeleteObjectiveAttachment(objectiveId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) => api.deleteObjectiveAttachment(objectiveId, attachmentId),
    onSuccess: remaining => {
      qc.setQueryData(keys.objectiveAttachments(objectiveId), remaining);
      void qc.invalidateQueries({ queryKey: keys.objectiveAttachments(objectiveId) });
    }
  });
}

export interface ReorderFutureObjectivesVars extends ReorderFutureObjectivesBody {
  missionId: string;
}

/**
 * Reorders a mission's future objectives with an optimistic cache update: the new
 * order shows instantly and is reverted only if the server rejects it. The
 * realtime SSE feed reconciles the cache with server truth on success.
 */
export function useReorderFutureObjectives() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ missionId, orderedObjectiveIds }: ReorderFutureObjectivesVars) =>
      api.reorderFutureObjectives(missionId, { orderedObjectiveIds }),
    onMutate: async (vars: ReorderFutureObjectivesVars) => {
      await qc.cancelQueries({ queryKey: keys.mission(vars.missionId) });
      const previous = qc.getQueryData<MissionDetailDto>(keys.mission(vars.missionId));
      if (previous) {
        // Renumber the future group to match the requested order, starting at the
        // lowest position it currently occupies, then re-sort by position.
        const orderIndex = new Map(vars.orderedObjectiveIds.map((id, index) => [id, index]));
        const basePosition = Math.min(
          ...previous.objectives.filter(o => orderIndex.has(o.id)).map(o => o.position)
        );
        const next = {
          ...previous,
          objectives: previous.objectives
            .map(objective => {
              const index = orderIndex.get(objective.id);
              return index === undefined
                ? objective
                : { ...objective, position: basePosition + index };
            })
            .sort((a, b) => a.position - b.position)
        };
        qc.setQueryData(keys.mission(vars.missionId), next);
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.mission(vars.missionId), context.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: keys.mission(vars.missionId) });
    }
  });
}

// ---- Agent launch ----------------------------------------------------------

export const useAgentCatalog = () =>
  useQuery({ queryKey: keys.agentCatalog, queryFn: api.getAgentCatalog, staleTime: 60_000 });

export const useLaunchSettings = () =>
  useQuery({ queryKey: keys.launchSettings, queryFn: api.getLaunchSettings, staleTime: 60_000 });

export const useLaunchPreference = (projectId: string) =>
  useQuery({
    queryKey: keys.launchPreference(projectId),
    queryFn: () => api.getLaunchPreference(projectId),
    staleTime: 60_000
  });

export function useLaunchObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LaunchObjectiveBody }) =>
      api.launchObjective(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateAgentLaunchConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentKey, body }: { agentKey: string; body: UpdateAgentLaunchConfigBody }) =>
      api.updateAgentLaunchConfig(agentKey, body),
    onSuccess: data => qc.setQueryData(keys.launchSettings, data)
  });
}

export function useUpdateTerminalProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTerminalProfileBody) => api.updateTerminalProfile(body),
    onSuccess: data => qc.setQueryData(keys.launchSettings, data)
  });
}

export function useUpdateLaunchPreference(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLaunchPreferenceBody) => api.updateLaunchPreference(projectId, body),
    onMutate: async body => {
      // Optimistic: selection changes should feel instant in the selector.
      await qc.cancelQueries({ queryKey: keys.launchPreference(projectId) });
      const previous = qc.getQueryData<LaunchPreferenceDto>(keys.launchPreference(projectId));
      if (previous) {
        qc.setQueryData(keys.launchPreference(projectId), { ...previous, ...body });
      }
      return { previous };
    },
    onError: (_err, _body, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.launchPreference(projectId), context.previous);
      }
    },
    onSuccess: data => qc.setQueryData(keys.launchPreference(projectId), data)
  });
}

export function useRefreshAgentCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshAgentCatalog(),
    onSuccess: data => qc.setQueryData(keys.agentCatalog, data)
  });
}
