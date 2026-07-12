import type {
  CreateEverhourTimeBody,
  LinkProjectEverhourBody,
  UpdateEverhourTimeBody
} from '@overlord/contract/ext/everhour';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AcceptWorkspaceInvitationBody,
  AddOrganizationAdminBody,
  BranchActionBody,
  CreateMissionBody,
  CreateObjectiveBody,
  CreateOrganizationOnboardingBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateUserTokenBody,
  CreateWebhookSubscriptionBody,
  CreateWorkspaceBody,
  CreateWorkspaceStatusBody,
  InviteWorkspaceMemberBody,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  MissionDetailDto,
  MissionDto,
  MissionScheduleDto,
  MyMissionsResponse,
  ObjectiveAttachmentDto,
  PreviewScheduleBody,
  ProjectTagDto,
  RemoveWorktreeBody,
  ReorderFutureObjectivesBody,
  ReorderProjectsBody,
  ReorderWorkspaceStatusesBody,
  ScheduleInput,
  StatusType,
  UpdateAgentCatalogBody,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateMissionBody,
  UpdateObjectiveBody,
  UpdateOrganizationBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectExecutionTargetBody,
  UpdateProjectResourceBody,
  UpdateProjectTagBody,
  UpdateTerminalProfileBody,
  UpdateUserTokenBody,
  UpdateWebhookSubscriptionBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceMemberRoleBody,
  UpdateWorkspaceStatusBody,
  UpdateWorktreeBranchAutomationBody,
  WorkspaceDto,
  WorkspaceExecutionTargetDto,
  WorkspaceStatusDto
} from '../../shared/contract.ts';

import { api, type Meta } from './api.ts';
import {
  clearAuthTokens,
  clearDesktopBearerToken,
  isCurrentDesktopBearerTokenPrefix,
  persistActiveWorkspaceId
} from './api-base.ts';
import { authClient, normalizeEmail } from './auth-client.ts';
import {
  fetchMissionBranchesFromLocalTarget,
  fetchWorktreesFromLocalTarget,
  gatherCommitDiffOnLocalTarget,
  purgeMergedWorktreesOnLocalTarget,
  removeWorktreeOnLocalTarget,
  resolveClientBranchActionContext,
  resolvePrimaryResourceForTarget,
  runBranchActionOnLocalTarget
} from './local-target-branch.ts';
import {
  isLocalTargetCapabilityAvailable,
  useLocalTargetCapabilityAvailable
} from './local-target-client.ts';
import {
  isRemoteExecutionTargetSelected,
  useIsRemoteExecutionTargetForProject
} from './local-target-remote.ts';
import { persistActiveOrganizationId } from './org-preferences.ts';
import {
  invalidateMissionEverhourQueries,
  invalidateNonEverhourQueries,
  invalidateProjectEverhourQueries
} from './query-invalidation.ts';

export const keys = {
  meta: ['meta'] as const,
  profile: ['profile'] as const,
  userTokens: ['user-tokens'] as const,
  webhookSubscriptions: ['webhooks'] as const,
  webhookDeliveries: (id: string) => ['webhooks', id, 'deliveries'] as const,
  organizations: ['organizations'] as const,
  organizationAdmins: (id: string) => ['organization', id, 'admins'] as const,
  workspaces: ['workspaces'] as const,
  workspaceMembers: (id: string) => ['workspace', id, 'members'] as const,
  workspaceExecutionTargets: (id: string) => ['workspace', id, 'execution-targets'] as const,
  workspaceInvitations: (id: string) => ['workspace', id, 'invitations'] as const,
  projects: (workspaceId?: string) =>
    workspaceId ? (['workspace', workspaceId, 'projects'] as const) : (['projects'] as const),
  project: (id: string) => ['project', id] as const,
  workspaceStatuses: (workspaceId?: string | null) =>
    workspaceId
      ? (['workspace', workspaceId, 'statuses'] as const)
      : (['workspace', 'statuses'] as const),
  projectResources: (id: string) => ['project', id, 'resources'] as const,
  projectTags: (id: string) => ['project', id, 'tags'] as const,
  projectRepository: (id: string, executionTargetId: string | null, resourceKey?: string | null) =>
    [
      'project',
      id,
      'repository',
      executionTargetId ?? 'primary',
      resourceKey ?? 'primary'
    ] as const,
  missions: (projectId: string) => ['project', projectId, 'missions'] as const,
  myMissions: ['workspace', 'my-missions'] as const,
  mission: (id: string) => ['mission', id] as const,
  missionSchedule: (id: string) => ['mission', id, 'schedule'] as const,
  missionBranches: (id: string) => ['mission', id, 'branches'] as const,
  worktrees: ['worktrees'] as const,
  missionEvents: (id: string) => ['mission', id, 'events'] as const,
  missionArtifacts: (id: string) => ['mission', id, 'artifacts'] as const,
  missionFileChanges: (id: string) => ['mission', id, 'file-changes'] as const,
  objectiveAttachments: (objectiveId: string) => ['objective', objectiveId, 'attachments'] as const,
  agentCatalog: ['agent-catalog'] as const,
  runnerStatus: ['runner', 'status'] as const,
  runnerServiceStatus: ['runner', 'service-status'] as const,
  launchSettings: ['launch-settings'] as const,
  launchPreference: (projectId: string) => ['project', projectId, 'launch-preference'] as const,
  projectExecutionTarget: (projectId: string) =>
    ['project', projectId, 'execution-target'] as const,
  everhourIntegration: ['integrations', 'everhour'] as const,
  projectEverhourLink: (projectId: string) => ['project', projectId, 'everhour-link'] as const,
  projectEverhour: (projectId: string) => ['project', projectId, 'everhour'] as const,
  missionEverhour: (id: string) => ['mission', id, 'everhour'] as const
};

// Mutations still invalidate eagerly so the originating user sees their change
// instantly; the realtime feed later reconciles the scoped query keys it can map.
function invalidateAll(qc: QueryClient) {
  invalidateNonEverhourQueries(qc);
}

function persistActiveWorkspaceFromList(workspaces: WorkspaceDto[]) {
  const active = workspaces.find(workspace => workspace.isActive);
  if (active) persistActiveWorkspaceId(active.id);
}

// ---- Queries -------------------------------------------------------------

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: api.meta });

export const useProfile = () => useQuery({ queryKey: keys.profile, queryFn: api.getProfile });

/**
 * Live runner queue status for the sidebar runner box. Polls on a light
 * interval so the subtle status indicator stays current without a realtime
 * subscription.
 */
export const useRunnerStatus = (options?: { enabled?: boolean; refetchInterval?: number }) =>
  useQuery({
    queryKey: keys.runnerStatus,
    queryFn: api.getRunnerStatus,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? 15_000
  });

/**
 * Local persistent-runner service state via the desktop bridge (`ovld runner
 * service status`). Resolves to null in a plain browser or when the bridge call
 * fails, so consumers can quietly fall back to queue-only signals.
 */
export const useRunnerServiceStatus = (options?: { enabled?: boolean }) => {
  const runnerService = typeof window === 'undefined' ? undefined : window.overlord?.runnerService;
  return useQuery({
    queryKey: keys.runnerServiceStatus,
    queryFn: async () => {
      if (!runnerService) return null;
      const result = await runnerService.getStatus();
      return result.ok ? (result.status ?? null) : null;
    },
    enabled: (options?.enabled ?? true) && Boolean(runnerService),
    // Each read spawns a CLI process; poll gently and reuse across consumers.
    refetchInterval: 60_000,
    staleTime: 30_000
  });
};

export const useUserTokens = () =>
  useQuery({ queryKey: keys.userTokens, queryFn: api.listUserTokens });

export const useWebhookSubscriptions = () =>
  useQuery({ queryKey: keys.webhookSubscriptions, queryFn: api.listWebhookSubscriptions });

export const useWebhookDeliveries = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.webhookDeliveries(id),
    queryFn: () => api.listWebhookDeliveries(id),
    enabled
  });

export const useOrganizations = () =>
  useQuery({ queryKey: keys.organizations, queryFn: api.listOrganizations });

export const useOrganizationAdmins = (id: string | null) =>
  useQuery({
    queryKey: keys.organizationAdmins(id ?? '__none__'),
    queryFn: () => api.listOrganizationAdmins(id ?? ''),
    enabled: Boolean(id)
  });

export const useWorkspaceExecutionTargets = (workspaceId: string) =>
  useQuery<WorkspaceExecutionTargetDto[]>({
    queryKey: keys.workspaceExecutionTargets(workspaceId),
    queryFn: () => api.getWorkspaceExecutionTargets(workspaceId),
    staleTime: 30_000
  });

export const useAccessibleWorkspaces = () => {
  const meta = useMeta();
  return meta.data?.workspaces ?? [];
};

export const useWorkspaces = () =>
  useQuery({ queryKey: keys.workspaces, queryFn: api.listWorkspaces });

export const useWorkspaceMembers = (id: string | null) =>
  useQuery({
    queryKey: keys.workspaceMembers(id ?? '__none__'),
    queryFn: () => api.listWorkspaceMembers(id ?? ''),
    enabled: Boolean(id)
  });

export const useWorkspaceInvitations = (id: string | null) =>
  useQuery({
    queryKey: keys.workspaceInvitations(id ?? '__none__'),
    queryFn: () => api.listWorkspaceInvitations(id ?? ''),
    enabled: Boolean(id)
  });

export const useProjects = (workspaceId?: string) => {
  const meta = useMeta();
  const targetWorkspaceId = workspaceId ?? meta.data?.workspace?.id;

  return useQuery({
    queryKey: keys.projects(targetWorkspaceId),
    queryFn: () => {
      if (!targetWorkspaceId) return Promise.resolve([]);
      return api.listProjectsForWorkspace(targetWorkspaceId);
    },
    enabled: Boolean(targetWorkspaceId)
  });
};

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) });

export const useWorkspaceStatuses = (workspaceId?: string | null) =>
  useQuery({
    queryKey: keys.workspaceStatuses(workspaceId),
    queryFn: () =>
      workspaceId
        ? api.listWorkspaceStatusesForWorkspace(workspaceId)
        : api.listWorkspaceStatuses(),
    enabled: workspaceId !== null
  });

export const useProjectResources = (id: string) =>
  useQuery({ queryKey: keys.projectResources(id), queryFn: () => api.listProjectResources(id) });

export const useProjectTags = (id: string | null) =>
  useQuery({
    queryKey: keys.projectTags(id ?? 'none'),
    queryFn: () => api.listProjectTags(id as string),
    enabled: Boolean(id)
  });

export const useProjectRepository = (
  id: string,
  executionTargetId: string | null,
  resourceKey?: string | null
) =>
  useQuery({
    queryKey: keys.projectRepository(id, executionTargetId, resourceKey ?? null),
    queryFn: () => api.getProjectRepository(id, executionTargetId, resourceKey ?? null)
  });

export const useMissions = (projectId: string) =>
  useQuery({ queryKey: keys.missions(projectId), queryFn: () => api.listMissions(projectId) });

// The active operator's assigned missions across the selected workspace. The
// realtime SSE feed invalidates this for mission/objective workflow changes, and
// the reorder mutation updates it optimistically.
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
export const useMissionBranches = ({
  missionId,
  projectId,
  current,
  enabled
}: {
  missionId: string;
  projectId: string;
  current: string | null;
  enabled: boolean;
}) => {
  const localTargetAvailable = useLocalTargetCapabilityAvailable();
  const executionTarget = useProjectExecutionTarget(projectId);
  const resources = useProjectResources(projectId);
  const selectedExecutionTargetId = executionTarget.data?.selectedExecutionTargetId ?? null;
  const primaryResource = resolvePrimaryResourceForTarget({
    resources: resources.data ?? [],
    executionTargetId: selectedExecutionTargetId
  });

  return useQuery({
    queryKey: keys.missionBranches(missionId),
    queryFn: async () => {
      if (localTargetAvailable && primaryResource) {
        return fetchMissionBranchesFromLocalTarget({ resource: primaryResource, current });
      }
      return api.listMissionBranches(missionId);
    },
    enabled: enabled && (!localTargetAvailable || Boolean(primaryResource)),
    staleTime: 30_000
  });
};

export const useWorktrees = () => {
  const localTargetAvailable = useLocalTargetCapabilityAvailable();
  const projects = useProjects();

  return useQuery({
    queryKey: keys.worktrees,
    queryFn: async () => {
      if (localTargetAvailable) {
        const projectList = projects.data ?? [];
        const resourceEntries = await Promise.all(
          projectList.map(
            async project => [project.id, await api.listProjectResources(project.id)] as const
          )
        );
        return fetchWorktreesFromLocalTarget({
          projects: projectList,
          projectResources: new Map(resourceEntries)
        });
      }
      return api.listWorktrees();
    },
    enabled: !localTargetAvailable || Boolean(projects.data),
    staleTime: 30_000
  });
};

// The realtime SSE feed invalidates this query for mission_event changes written
// by the CLI/agent in another process, so the activity feed updates without
// bespoke wiring here.
export const useMissionEvents = (id: string) =>
  useQuery({ queryKey: keys.missionEvents(id), queryFn: () => api.listMissionEvents(id) });

export const useMissionArtifacts = (id: string) =>
  useQuery({ queryKey: keys.missionArtifacts(id), queryFn: () => api.listMissionArtifacts(id) });

// Change rationale writes currently arrive through broad fallback invalidation
// unless a future feed row carries a more specific file-change entity type.
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
 * Change the account email through the Auth surface. Email is the primary
 * account identifier, so this updates the Better Auth account email directly;
 * the auth→profiles bridge then mirrors the new email into `profiles.email`.
 */
export function useChangeEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rawEmail: string) => {
      const email = normalizeEmail(rawEmail);
      const reemailed = await authClient.changeEmail({ newEmail: email });
      if (reemailed.error) {
        throw new Error(reemailed.error.message ?? 'Failed to update email.');
      }
      return email;
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
 * Permanently delete the signed-in account through the Auth surface. The
 * server cascades workspace memberships, tokens, and avatar images before
 * removing the underlying auth user (see backend/account-deletion.ts), then
 * clears the session cookie itself — this only needs to drop local tokens
 * once the call succeeds so the next render sees a signed-out state.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async (password: string) => {
      const result = await authClient.deleteUser({ password });
      if (result.error) {
        throw new Error(result.error.message ?? 'Failed to delete account.');
      }
    },
    onSuccess: async () => {
      await clearAuthTokens();
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

/**
 * Upload an image to the `organization-images` bucket and set it as the given
 * organization's logo. Org-admin-only on the server side.
 */
export function useUploadOrganizationLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ organizationId, file }: { organizationId: string; file: File }) => {
      const stored = await api.uploadImage('organization-images', file);
      return api.updateOrganization(organizationId, { logoUrl: stored.url });
    },
    onSuccess: () => invalidateAll(qc)
  });
}

export function useCreateOrganizationOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrganizationOnboardingBody) => api.createOrganizationOnboarding(body),
    onSuccess: data => {
      if (data.organization) persistActiveOrganizationId(data.organization.id);
      if (data.workspace) persistActiveWorkspaceId(data.workspace.id);
      invalidateAll(qc);
    }
  });
}

export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateOrganizationBody }) =>
      api.updateOrganization(id, body),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useActivateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (organizationId: string) => {
      persistActiveOrganizationId(organizationId);
      const workspaces = await api.listWorkspaces();
      const target =
        workspaces.find(
          workspace => workspace.organizationId === organizationId && workspace.isActive
        ) ?? workspaces.find(workspace => workspace.organizationId === organizationId);
      if (!target) throw new Error('No workspace found in this organization');
      return api.activateWorkspace(target.id);
    },
    onSuccess: data => {
      persistActiveWorkspaceFromList(data);
      invalidateAll(qc);
    }
  });
}

export function useAddOrganizationAdmin(organizationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddOrganizationAdminBody) => api.addOrganizationAdmin(organizationId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.organizationAdmins(organizationId) });
      invalidateAll(qc);
    }
  });
}

export function useRemoveOrganizationAdmin(organizationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.removeOrganizationAdmin(organizationId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.organizationAdmins(organizationId) });
      invalidateAll(qc);
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
    onSuccess: token => {
      if (isCurrentDesktopBearerTokenPrefix(token.tokenPrefix)) {
        void clearDesktopBearerToken();
      }
      void qc.invalidateQueries({ queryKey: keys.userTokens });
    }
  });
}

export function useCreateWebhookSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWebhookSubscriptionBody) => api.createWebhookSubscription(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSubscriptions })
  });
}

export function useUpdateWebhookSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWebhookSubscriptionBody }) =>
      api.updateWebhookSubscription(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSubscriptions })
  });
}

export function useDeleteWebhookSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWebhookSubscription(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSubscriptions })
  });
}

export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSubscriptions })
  });
}

export function useTestWebhookSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testWebhookSubscription(id),
    onSuccess: (_result, id) => void qc.invalidateQueries({ queryKey: keys.webhookDeliveries(id) })
  });
}

export function useRedeliverWebhookDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outboxId }: { id: string; outboxId: string }) =>
      api.redeliverWebhookDelivery(id, outboxId),
    onSuccess: (_result, { id }) =>
      void qc.invalidateQueries({ queryKey: keys.webhookDeliveries(id) })
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

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceBody) => api.createWorkspace(body),
    onSuccess: data => {
      persistActiveWorkspaceId(data.id);
      invalidateAll(qc);
    }
  });
}

export function useActivateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.activateWorkspace(id),
    // Switching workspace changes what every scoped query returns.
    onSuccess: data => {
      persistActiveWorkspaceFromList(data);
      invalidateAll(qc);
    }
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
    onSuccess: data => {
      persistActiveWorkspaceFromList(data);
      invalidateAll(qc);
    }
  });
}

export function useInviteWorkspaceMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteWorkspaceMemberBody) => api.inviteWorkspaceMember(workspaceId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaceInvitations(workspaceId) })
  });
}

export function useRevokeWorkspaceInvitation(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => api.revokeWorkspaceInvitation(workspaceId, invitationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaceInvitations(workspaceId) })
  });
}

export function useRemoveWorkspaceMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceUserId: string) =>
      api.removeWorkspaceMember(workspaceId, workspaceUserId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaceMembers(workspaceId) })
  });
}

export function useUpdateWorkspaceMemberRole(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceUserId,
      body
    }: {
      workspaceUserId: string;
      body: UpdateWorkspaceMemberRoleBody;
    }) => api.updateWorkspaceMemberRole(workspaceId, workspaceUserId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workspaceMembers(workspaceId) })
  });
}

export function useAcceptWorkspaceInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptWorkspaceInvitationBody) => api.acceptWorkspaceInvitation(body),
    // Accepting grants a brand-new workspace membership, so the whole cache is stale.
    onSuccess: data => {
      persistActiveWorkspaceId(data.id);
      invalidateAll(qc);
    }
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

export function useReorderProjects(workspaceId?: string) {
  const qc = useQueryClient();
  const meta = useMeta();
  const targetWorkspaceId = workspaceId ?? meta.data?.workspace?.id;

  return useMutation({
    mutationFn: (body: ReorderProjectsBody) => api.reorderProjects(body),
    onSuccess: data => {
      if (targetWorkspaceId) {
        qc.setQueryData(keys.projects(targetWorkspaceId), data);
        void qc.invalidateQueries({ queryKey: keys.projects(targetWorkspaceId) });
      }
      invalidateAll(qc);
    }
  });
}

// The status mutation hooks take an optional `workspaceId`. When set (the
// settings modal for a specific workspace) they target the workspace-scoped
// routes and cache the result under that workspace's key; when omitted they use
// the active-workspace legacy routes (coo:135).
export function useCreateWorkspaceStatus(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceStatusBody) => api.createWorkspaceStatus(body, workspaceId),
    onSuccess: data => {
      qc.setQueryData(
        keys.workspaceStatuses(workspaceId),
        (prev: WorkspaceStatusDto[] | undefined) =>
          prev ? [...prev, data].sort((a, b) => a.position - b.position) : [data]
      );
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    }
  });
}

export function useUpdateWorkspaceStatus(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statusId, body }: { statusId: string; body: UpdateWorkspaceStatusBody }) =>
      api.updateWorkspaceStatus(statusId, body, workspaceId),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useDeleteWorkspaceStatus(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (statusId: string) => api.deleteWorkspaceStatus(statusId, workspaceId),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useReorderWorkspaceStatuses(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReorderWorkspaceStatusesBody) =>
      api.reorderWorkspaceStatuses(body, workspaceId),
    onSuccess: data => {
      qc.setQueryData(keys.workspaceStatuses(workspaceId), data);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
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
    onSuccess: data => {
      qc.setQueryData(keys.mission(id), data);
      invalidateAll(qc);
    }
  });
}

export function useMissionSchedule(missionId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: keys.missionSchedule(missionId),
    queryFn: () => api.getMissionSchedule(missionId),
    enabled: options?.enabled ?? true
  });
}

export function useUpsertMissionSchedule(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleInput) => api.upsertMissionSchedule(missionId, body),
    onSuccess: data => {
      qc.setQueryData(keys.missionSchedule(missionId), data);
      void qc.invalidateQueries({ queryKey: keys.mission(missionId) });
      invalidateAll(qc);
    }
  });
}

export function useClearMissionSchedule(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearMissionSchedule(missionId),
    onSuccess: () => {
      qc.setQueryData(keys.missionSchedule(missionId), {
        dueDatetime: null,
        schedule: null
      } satisfies MissionScheduleDto);
      void qc.invalidateQueries({ queryKey: keys.mission(missionId) });
      invalidateAll(qc);
    }
  });
}

export function usePreviewScheduleDueDatetime() {
  return useMutation({
    mutationFn: (body: PreviewScheduleBody) => api.previewMissionSchedule(body)
  });
}

export function useDeleteMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMission(id),
    onSuccess: () => invalidateAll(qc)
  });
}

export function useSetMissionStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ missionId, statusId }: { missionId: string; statusId: string }) =>
      api.updateMission(missionId, { statusId }),
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

export function useGenerateCommitMessage(mission: MissionDetailDto) {
  return useMutation({
    mutationFn: async () => {
      if (await isLocalTargetCapabilityAvailable()) {
        const resources = await api.listProjectResources(mission.projectId);
        const executionTarget = await api.getProjectExecutionTarget(mission.projectId);
        const context = await resolveClientBranchActionContext({
          mission,
          resources,
          executionTargetId: executionTarget.selectedExecutionTargetId
        });
        if (!context) {
          throw new Error('This mission has no prepared branch worktree on this device.');
        }
        const diff = await gatherCommitDiffOnLocalTarget({ worktreePath: context.worktreePath });
        return api.generateCommitMessage(mission.id, { diff });
      }
      return api.generateCommitMessage(mission.id);
    }
  });
}

export function useBranchAction(mission: MissionDetailDto) {
  const qc = useQueryClient();
  const isRemoteTarget = useIsRemoteExecutionTargetForProject(mission.projectId);
  return useMutation({
    mutationFn: async (body: BranchActionBody) => {
      if (isRemoteTarget) {
        return api.branchAction(mission.id, body);
      }
      if (await isLocalTargetCapabilityAvailable()) {
        const resources = await api.listProjectResources(mission.projectId);
        const executionTarget = await api.getProjectExecutionTarget(mission.projectId);
        const context = await resolveClientBranchActionContext({
          mission,
          resources,
          executionTargetId: executionTarget.selectedExecutionTargetId
        });
        if (!context) {
          throw new Error('This mission has no prepared branch worktree on this device.');
        }
        const summary = await runBranchActionOnLocalTarget({ context, body });
        return api.branchAction(mission.id, {
          action: body.action,
          confirmBusy: body.confirmBusy,
          message: body.message,
          clientExecuted: true,
          summary
        });
      }
      return api.branchAction(mission.id, body);
    },
    onSuccess: () => invalidateAll(qc)
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  const localTargetAvailable = useLocalTargetCapabilityAvailable();
  const projects = useProjects();

  return useMutation({
    mutationFn: async (body: RemoveWorktreeBody) => {
      const projectList = projects.data ?? [];
      const resourceEntries = await Promise.all(
        projectList.map(
          async project => [project.id, await api.listProjectResources(project.id)] as const
        )
      );
      const worktrees = localTargetAvailable
        ? await fetchWorktreesFromLocalTarget({
            projects: projectList,
            projectResources: new Map(resourceEntries)
          })
        : [];
      const match = worktrees.find(worktree => worktree.path === body.path);
      const projectId = body.projectId ?? match?.projectId;
      const isRemoteTarget = projectId
        ? isRemoteExecutionTargetSelected({
            localExecutionTargetId: (await api.getLaunchSettings()).executionTargetId,
            selectedExecutionTargetId: (await api.getProjectExecutionTarget(projectId))
              .selectedExecutionTargetId
          })
        : false;

      if (isRemoteTarget && projectId) {
        const resources = await api.listProjectResources(projectId);
        const executionTarget = await api.getProjectExecutionTarget(projectId);
        const primary = resolvePrimaryResourceForTarget({
          resources,
          executionTargetId: executionTarget.selectedExecutionTargetId
        });
        return api.removeWorktree({
          ...body,
          projectId,
          executionTargetId: executionTarget.selectedExecutionTargetId,
          primaryRepoPath: primary?.path ?? body.primaryRepoPath
        });
      }

      if (localTargetAvailable) {
        const resources = match ? await api.listProjectResources(match.projectId) : [];
        const primary = resolvePrimaryResourceForTarget({
          resources,
          executionTargetId: null
        });
        return removeWorktreeOnLocalTarget({
          body: { ...body, primaryRepoPath: primary?.path ?? body.primaryRepoPath },
          projects: projectList,
          projectResources: new Map(resourceEntries)
        });
      }
      return api.removeWorktree(body);
    },
    onSuccess: result => {
      qc.setQueryData(keys.worktrees, result.worktrees);
      void qc.invalidateQueries({ queryKey: keys.worktrees });
    }
  });
}

export function usePurgeMergedWorktrees() {
  const qc = useQueryClient();
  const localTargetAvailable = useLocalTargetCapabilityAvailable();
  const projects = useProjects();

  return useMutation({
    mutationFn: async () => {
      const projectList = projects.data ?? [];
      const launchSettings = await api.getLaunchSettings();
      const remoteProjects = (
        await Promise.all(
          projectList.map(async project => {
            const executionTarget = await api.getProjectExecutionTarget(project.id);
            const isRemote = isRemoteExecutionTargetSelected({
              localExecutionTargetId: launchSettings.executionTargetId,
              selectedExecutionTargetId: executionTarget.selectedExecutionTargetId
            });
            if (!isRemote) return null;
            const resources = await api.listProjectResources(project.id);
            const primary = resolvePrimaryResourceForTarget({
              resources,
              executionTargetId: executionTarget.selectedExecutionTargetId
            });
            if (!primary?.path) return null;
            return {
              projectId: project.id,
              executionTargetId: executionTarget.selectedExecutionTargetId,
              primaryRepoPath: primary.path
            };
          })
        )
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      if (remoteProjects.length > 0) {
        for (const project of remoteProjects) {
          await api.purgeMergedWorktrees(project);
        }
        return { removed: [], skipped: [], worktrees: [] };
      }

      if (localTargetAvailable) {
        const resourceEntries = await Promise.all(
          projectList.map(
            async project => [project.id, await api.listProjectResources(project.id)] as const
          )
        );
        return purgeMergedWorktreesOnLocalTarget({
          projects: projectList,
          projectResources: new Map(resourceEntries)
        });
      }
      return api.purgeMergedWorktrees();
    },
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

export const useObjectiveAttachments = (
  objectiveId: string,
  { enabled = true }: { enabled?: boolean } = {}
) =>
  useQuery({
    queryKey: keys.objectiveAttachments(objectiveId),
    queryFn: () => api.listObjectiveAttachments(objectiveId),
    enabled
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

export const useProjectExecutionTarget = (projectId: string) =>
  useQuery({
    queryKey: keys.projectExecutionTarget(projectId),
    queryFn: () => api.getProjectExecutionTarget(projectId),
    staleTime: 30_000
  });

export function useUpdateProjectExecutionTarget(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectExecutionTargetBody) =>
      api.updateProjectExecutionTarget(projectId, body),
    onSuccess: data => {
      qc.setQueryData(keys.projectExecutionTarget(projectId), data);
      void qc.invalidateQueries({
        queryKey: keys.projectRepository(projectId, data.selectedExecutionTargetId)
      });
    }
  });
}

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

export function useUpdateAgentCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAgentCatalogBody) => api.updateAgentCatalog(body),
    onSuccess: data => qc.setQueryData(keys.agentCatalog, data)
  });
}

// ---- Everhour integration ------------------------------------------------

/** Workspace Everhour connection state. Used to gate all Everhour UI. */
export const useEverhourIntegration = () =>
  useQuery({ queryKey: keys.everhourIntegration, queryFn: () => api.getEverhourIntegration() });

export function useSetEverhourApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) => api.setEverhourApiKey(apiKey),
    onSuccess: data => {
      qc.setQueryData(keys.everhourIntegration, data);
      invalidateMissionEverhourQueries(qc);
      invalidateProjectEverhourQueries(qc);
    }
  });
}

export function useClearEverhourApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearEverhourApiKey(),
    onSuccess: data => {
      qc.setQueryData(keys.everhourIntegration, data);
      invalidateMissionEverhourQueries(qc);
      invalidateProjectEverhourQueries(qc);
    }
  });
}

export function useLinkProjectEverhour(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LinkProjectEverhourBody) => api.linkProjectEverhour(projectId, body),
    onSuccess: data => {
      qc.setQueryData(keys.projectEverhourLink(projectId), data);
      invalidateMissionEverhourQueries(qc);
      invalidateProjectEverhourQueries(qc);
    }
  });
}

export const useProjectEverhourLink = (projectId: string, options: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: keys.projectEverhourLink(projectId),
    queryFn: () => api.getProjectEverhourLink(projectId),
    enabled: options.enabled ?? true
  });

/**
 * Everhour state for one project's fixed `general` task. Only enabled once we
 * know the workspace is connected. Polls while the caller opts in (e.g. a
 * running timer) to keep elapsed time roughly fresh.
 */
export const useProjectEverhour = (
  projectId: string,
  options: { enabled?: boolean; poll?: boolean } = {}
) =>
  useQuery({
    queryKey: keys.projectEverhour(projectId),
    queryFn: () => api.getProjectEverhour(projectId),
    enabled: options.enabled ?? true,
    staleTime: options.poll ? 0 : 5 * 60_000,
    refetchInterval: options.poll ? 15_000 : false
  });

export function useStartProjectTimer(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startProjectTimer(projectId),
    onSuccess: data => {
      qc.setQueryData(keys.projectEverhour(projectId), data);
      invalidateMissionEverhourQueries(qc);
    }
  });
}

export function useStopProjectTimer(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopProjectTimer(projectId),
    onSuccess: data => {
      qc.setQueryData(keys.projectEverhour(projectId), data);
      invalidateMissionEverhourQueries(qc);
    }
  });
}

export function useAddProjectTime(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEverhourTimeBody) => api.addProjectTime(projectId, body),
    onSuccess: data => qc.setQueryData(keys.projectEverhour(projectId), data)
  });
}

export function useUpdateProjectTime(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, body }: { recordId: string; body: UpdateEverhourTimeBody }) =>
      api.updateProjectTime(projectId, recordId, body),
    onSuccess: data => qc.setQueryData(keys.projectEverhour(projectId), data)
  });
}

export function useDeleteProjectTime(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recordId: string) => api.deleteProjectTime(projectId, recordId),
    onSuccess: data => qc.setQueryData(keys.projectEverhour(projectId), data)
  });
}

/**
 * Everhour state for one mission. Only enabled once we know the workspace is
 * connected, so a disconnected workspace never hits the proxy. Polls while the
 * caller opts in (e.g. a running timer) to keep elapsed time roughly fresh.
 */
export const useMissionEverhour = (
  id: string,
  options: { enabled?: boolean; poll?: boolean } = {}
) =>
  useQuery({
    queryKey: keys.missionEverhour(id),
    queryFn: () => api.getMissionEverhour(id),
    enabled: options.enabled ?? true,
    staleTime: options.poll ? 0 : 5 * 60_000,
    refetchInterval: options.poll ? 15_000 : false
  });

export function useStartMissionTimer(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startMissionTimer(missionId),
    onSuccess: data => {
      qc.setQueryData(keys.missionEverhour(missionId), data);
      invalidateProjectEverhourQueries(qc);
    }
  });
}

export function useStopMissionTimer(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopMissionTimer(missionId),
    onSuccess: data => {
      qc.setQueryData(keys.missionEverhour(missionId), data);
      invalidateProjectEverhourQueries(qc);
    }
  });
}

export function useAddMissionTime(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEverhourTimeBody) => api.addMissionTime(missionId, body),
    onSuccess: data => qc.setQueryData(keys.missionEverhour(missionId), data)
  });
}

export function useUpdateMissionTime(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, body }: { recordId: string; body: UpdateEverhourTimeBody }) =>
      api.updateMissionTime(missionId, recordId, body),
    onSuccess: data => qc.setQueryData(keys.missionEverhour(missionId), data)
  });
}

export function useDeleteMissionTime(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recordId: string) => api.deleteMissionTime(missionId, recordId),
    onSuccess: data => qc.setQueryData(keys.missionEverhour(missionId), data)
  });
}
