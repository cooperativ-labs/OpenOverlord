import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CompleteInitialSetupBody,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectStatusBody,
  CreateProjectTagBody,
  CreateTicketBody,
  CreateUserTokenBody,
  CreateWorkspaceBody,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  ObjectiveAttachmentDto,
  ProjectStatusDto,
  ProjectTagDto,
  ReorderFutureObjectivesBody,
  ReorderProjectStatusesBody,
  StatusType,
  TicketDetailDto,
  TicketDto,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectStatusBody,
  UpdateProjectTagBody,
  UpdateTerminalProfileBody,
  UpdateTicketBody,
  UpdateUserTokenBody,
  UpdateWorkspaceBody
} from '../../shared/contract.ts';

import { api } from './api.ts';

export const keys = {
  meta: ['meta'] as const,
  profile: ['profile'] as const,
  userTokens: ['user-tokens'] as const,
  workspaces: ['workspaces'] as const,
  workspaceMembers: (id: string) => ['workspace', id, 'members'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectStatuses: (id: string) => ['project', id, 'statuses'] as const,
  projectResources: (id: string) => ['project', id, 'resources'] as const,
  projectTags: (id: string) => ['project', id, 'tags'] as const,
  projectRepository: (id: string, executionTargetId: string | null) =>
    ['project', id, 'repository', executionTargetId ?? 'primary'] as const,
  tickets: (projectId: string) => ['project', projectId, 'tickets'] as const,
  ticket: (id: string) => ['ticket', id] as const,
  ticketEvents: (id: string) => ['ticket', id, 'events'] as const,
  ticketArtifacts: (id: string) => ['ticket', id, 'artifacts'] as const,
  ticketFileChanges: (id: string) => ['ticket', id, 'file-changes'] as const,
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

export const useProjectStatuses = (id: string) =>
  useQuery({ queryKey: keys.projectStatuses(id), queryFn: () => api.listProjectStatuses(id) });

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

export const useTickets = (projectId: string) =>
  useQuery({ queryKey: keys.tickets(projectId), queryFn: () => api.listTickets(projectId) });

export const useTicket = (id: string) =>
  useQuery({ queryKey: keys.ticket(id), queryFn: () => api.getTicket(id) });

// The global realtime SSE feed invalidates this query whenever the database
// changes — including ticket_events written by the CLI/agent in another process
// — so the activity feed updates in real time without bespoke wiring here.
export const useTicketEvents = (id: string) =>
  useQuery({ queryKey: keys.ticketEvents(id), queryFn: () => api.listTicketEvents(id) });

export const useTicketArtifacts = (id: string) =>
  useQuery({ queryKey: keys.ticketArtifacts(id), queryFn: () => api.listTicketArtifacts(id) });

// Like the activity feed, the global realtime SSE feed invalidates this query
// whenever the database changes — including change_rationales recorded by the
// CLI/agent in another process — so the File Changes section stays current
// without bespoke wiring here.
export const useTicketFileChanges = (id: string) =>
  useQuery({ queryKey: keys.ticketFileChanges(id), queryFn: () => api.listTicketFileChanges(id) });

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

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompleteInitialSetupBody) => api.completeSetup(body),
    // Setup renames the active workspace and changes its slug, which feed
    // `/api/meta`, the sidebar identity, and future ticket identifiers.
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

export function useCreateProjectStatus(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectStatusBody) => api.createProjectStatus(projectId, body),
    onSuccess: data => {
      qc.setQueryData(keys.projectStatuses(projectId), (prev: ProjectStatusDto[] | undefined) =>
        prev ? [...prev, data].sort((a, b) => a.position - b.position) : [data]
      );
      void qc.invalidateQueries({ queryKey: keys.projectStatuses(projectId) });
    }
  });
}

export function useUpdateProjectStatus(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statusId, body }: { statusId: string; body: UpdateProjectStatusBody }) =>
      api.updateProjectStatus(projectId, statusId, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteProjectStatus(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statusId: string) => api.deleteProjectStatus(projectId, statusId),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useReorderProjectStatuses(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReorderProjectStatusesBody) => api.reorderProjectStatuses(projectId, body),
    onSuccess: data => {
      qc.setQueryData(keys.projectStatuses(projectId), data);
      void qc.invalidateQueries({ queryKey: keys.projectStatuses(projectId) });
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

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTicketBody) => api.createTicket(body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useUpdateTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTicketBody) => api.updateTicket(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTicket(id),
    onSuccess: () => invalidateAll(qc)
  });
}

export interface ReorderBoardColumnVars {
  projectId: string;
  /** Destination column / status. */
  statusId: string;
  /** Destination column's semantic type — used only for the optimistic patch. */
  statusType: StatusType;
  /** Every ticket id that should occupy the column, top-to-bottom, after the move. */
  orderedTicketIds: string[];
}

/** Mirrors the server's board order: board_position ASC, sequence_number DESC. */
function byBoardOrder(a: TicketDto, b: TicketDto): number {
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
    mutationFn: ({ projectId, statusId, orderedTicketIds }: ReorderBoardColumnVars) =>
      api.reorderBoardColumn(projectId, { statusId, orderedTicketIds }),
    onMutate: async (vars: ReorderBoardColumnVars) => {
      await qc.cancelQueries({ queryKey: keys.tickets(vars.projectId) });
      const previous = qc.getQueryData<TicketDto[]>(keys.tickets(vars.projectId));
      if (previous) {
        const positionById = new Map(
          vars.orderedTicketIds.map((id, index) => [id, (index + 1) * 100])
        );
        const next = previous
          .map(ticket => {
            const position = positionById.get(ticket.id);
            return position === undefined
              ? ticket
              : {
                  ...ticket,
                  statusId: vars.statusId,
                  statusType: vars.statusType,
                  boardPosition: position
                };
          })
          .sort(byBoardOrder);
        qc.setQueryData(keys.tickets(vars.projectId), next);
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.tickets(vars.projectId), context.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: keys.tickets(vars.projectId) });
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
  ticketId: string;
}

/**
 * Reorders a ticket's future objectives with an optimistic cache update: the new
 * order shows instantly and is reverted only if the server rejects it. The
 * realtime SSE feed reconciles the cache with server truth on success.
 */
export function useReorderFutureObjectives() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, orderedObjectiveIds }: ReorderFutureObjectivesVars) =>
      api.reorderFutureObjectives(ticketId, { orderedObjectiveIds }),
    onMutate: async (vars: ReorderFutureObjectivesVars) => {
      await qc.cancelQueries({ queryKey: keys.ticket(vars.ticketId) });
      const previous = qc.getQueryData<TicketDetailDto>(keys.ticket(vars.ticketId));
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
        qc.setQueryData(keys.ticket(vars.ticketId), next);
      }
      return { previous };
    },
    onError: (_err, vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.ticket(vars.ticketId), context.previous);
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: keys.ticket(vars.ticketId) });
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
