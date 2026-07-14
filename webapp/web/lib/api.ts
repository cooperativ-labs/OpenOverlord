import type {
  CreateEverhourTimeBody,
  EverhourIntegrationDto,
  LinkProjectEverhourBody,
  MissionEverhourStateDto,
  ProjectEverhourLinkDto,
  ProjectEverhourStateDto,
  UpdateEverhourTimeBody
} from '@overlord/contract/ext/everhour';
import type {
  CreateGitHubPullRequestBody,
  GitHubInstallUrlDto,
  GitHubIntegrationDto,
  GitHubPullRequestDto,
  GitHubRepoSummaryDto,
  LinkProjectGitHubBody,
  ProjectGitHubLinkDto
} from '@overlord/contract/ext/github';

import type { LocalTargetBridgeCall } from '../../../packages/core/service/local-target/desktop-bridge.ts';
import type { CapabilityResult } from '../../../packages/core/service/local-target/types.ts';
import type {
  AcceptWorkspaceInvitationBody,
  AddOrganizationAdminBody,
  AgentCatalogDto,
  ArtifactDto,
  BranchActionBody,
  CreateMissionBody,
  CreateObjectiveBody,
  CreateOrganizationOnboardingBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  CreateWebhookSubscriptionBody,
  CreateWebhookSubscriptionResultDto,
  CreateWorkspaceBody,
  CreateWorkspaceStatusBody,
  ExecutionRequestDto,
  FileChangeDto,
  GenerateCommitMessageBody,
  GenerateCommitMessageResultDto,
  InviteWorkspaceMemberBody,
  InviteWorkspaceMemberResultDto,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  LaunchSettingsDto,
  MetaDto,
  MissionBranchListDto,
  MissionDetailDto,
  MissionDto,
  MissionEventDto,
  MissionScheduleDto,
  MyMissionReorderRequest,
  MyMissionsResponse,
  ObjectiveAttachmentDto,
  ObjectiveDto,
  ObjectivePromptDto,
  OrganizationAdminDto,
  OrganizationDto,
  PreviewScheduleBody,
  ProfileDto,
  ProjectDto,
  ProjectExecutionTargetDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectTagDto,
  PurgeMergedWorktreesBody,
  PurgeWorktreesResultDto,
  RecordMissionBranchObservationsBody,
  RecordMissionBranchObservationsResult,
  RecordTargetResourceObservationsBody,
  RecordTargetResourceObservationsResult,
  RemoveWorktreeBody,
  ReorderBoardColumnBody,
  ReorderFutureObjectivesBody,
  ReorderProjectsBody,
  ReorderWorkspaceStatusesBody,
  RotateWebhookSecretResultDto,
  ScheduleInput,
  StoredImageDto,
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
  UserTokenDto,
  WebhookDeliveryAttemptsPageDto,
  WebhookSubscriptionDto,
  WorkspaceDto,
  WorkspaceExecutionTargetDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto,
  WorkspaceStatusDto,
  WorktreeDto
} from '../../shared/contract.ts';

export type LocalTargetServerCapability = 'in_process_server' | 'unavailable';

export interface MetaCapabilities {
  projects: boolean;
  missions: boolean;
  objectives: boolean;
  realtime: boolean;
  sqlStudio: boolean;
  launchAgents: boolean;
  executionTargets: boolean;
  localTarget: LocalTargetServerCapability;
  mcp: boolean;
}

/** Interactive login providers this backend offers (drives the auth UI). */
export interface AuthProviders {
  email: boolean;
  github: boolean;
}

export interface Meta extends MetaDto {
  databasePath: string;
  backendMode: 'local' | 'cloud';
  web: { host: string; port: number; url: string };
  sqlStudio: { enabled: boolean; url: string | null };
  authProviders: AuthProviders;
  capabilities: MetaCapabilities;
}

/** Error thrown for a non-2xx REST response; carries the server's typed `code`. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Machine-readable code (e.g. `STATUS_UNAVAILABLE_FOR_WORKSPACE`), when present. */
    public code?: string,
    /**
     * The server's `detail` field on its own. `message` already folds this in for
     * generic display; `detail` is kept separate so callers that render a tailored
     * message per `code` can surface the specifics (paths, files) on their own line.
     */
    public detail?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

import { fetchApi } from './api-transport.ts';

/**
 * Build an {@link ApiRequestError} from a non-2xx response, folding the server's
 * JSON `error`/`detail`/`code` shape into a display message. Shared by every
 * request helper so error extraction lives in one place.
 */
async function parseErrorResponse(res: Response): Promise<ApiRequestError> {
  let message = `${res.status} ${res.statusText}`;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const payload = (await res.json()) as { error?: string; detail?: string; code?: string };
    message = payload.error ?? message;
    detail = payload.detail;
    if (payload.detail) message += ` — ${payload.detail}`;
    code = payload.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiRequestError(message, res.status, code, detail);
}

/** One queued/active execution request as surfaced by `/api/runner/status`. */
export interface RunnerQueueRequest {
  id: string;
  projectId: string | null;
  missionId: string | null;
  objectiveId: string | null;
  requestedAgent: string | null;
  status: string;
  workingDirectory: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Response shape of `GET /api/runner/status`. */
export interface RunnerQueueStatus {
  queue: RunnerQueueRequest[];
  activeCount: number;
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  rawHeaders?: Record<string, string>
): Promise<T> {
  // A Blob/File body is sent as-is (used by the upload service); everything else
  // is JSON. `rawHeaders` lets callers send a binary body with its own headers.
  const isRaw = rawHeaders !== undefined;
  const res = await fetchApi(url, {
    method,
    headers: isRaw
      ? rawHeaders
      : body !== undefined
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body: isRaw ? (body as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function parseDownloadFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const basic = disposition.match(/filename="([^"]+)"/i) ?? disposition.match(/filename=([^;]+)/i);
  return basic?.[1]?.trim() ?? null;
}

async function requestDownload(
  method: string,
  url: string
): Promise<{ blob: Blob; filename: string | null }> {
  const res = await fetchApi(url, { method });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return {
    blob: await res.blob(),
    filename: parseDownloadFilename(res.headers.get('content-disposition'))
  };
}

export const api = {
  meta: () => request<Meta>('GET', '/api/meta'),
  /** Public (pre-auth) login-provider advertisement for the sign-in screen. */
  authProviders: () => request<AuthProviders>('GET', '/api/auth-providers'),
  createOrganizationOnboarding: (body: CreateOrganizationOnboardingBody) =>
    request<Meta>('POST', '/api/onboarding', body),

  listOrganizations: () => request<OrganizationDto[]>('GET', '/api/organizations'),
  updateOrganization: (id: string, body: UpdateOrganizationBody) =>
    request<OrganizationDto>('PATCH', `/api/organizations/${id}`, body),
  listOrganizationAdmins: (id: string) =>
    request<OrganizationAdminDto[]>('GET', `/api/organizations/${id}/admins`),
  addOrganizationAdmin: (id: string, body: AddOrganizationAdminBody) =>
    request<OrganizationAdminDto[]>('POST', `/api/organizations/${id}/admins`, body),
  removeOrganizationAdmin: (id: string, userId: string) =>
    request<OrganizationAdminDto[]>(
      'DELETE',
      `/api/organizations/${id}/admins/${encodeURIComponent(userId)}`
    ),

  getProfile: () => request<ProfileDto>('GET', '/api/profile'),
  updateProfile: (body: UpdateProfileBody) => request<ProfileDto>('PATCH', '/api/profile', body),

  /**
   * Core upload service: stream a single image File to a storage bucket and get
   * back its stored descriptor (including the URL that serves it). The raw bytes
   * are sent as the request body; the filename rides in a header so the server
   * can record it without multipart parsing.
   */
  uploadImage: (bucketKey: string, file: File) =>
    request<StoredImageDto>('POST', `/api/uploads/${encodeURIComponent(bucketKey)}`, file, {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Filename': encodeURIComponent(file.name)
    }),

  listUserTokens: () => request<UserTokenDto[]>('GET', '/api/user-tokens'),
  createUserToken: (body: CreateUserTokenBody) =>
    request<CreateUserTokenResultDto>('POST', '/api/user-tokens', body),
  renameUserToken: (id: string, body: UpdateUserTokenBody) =>
    request<UserTokenDto>('PATCH', `/api/user-tokens/${id}`, body),
  revokeUserToken: (id: string) => request<UserTokenDto>('POST', `/api/user-tokens/${id}/revoke`),

  listWebhookSubscriptions: () => request<WebhookSubscriptionDto[]>('GET', '/api/webhooks'),
  createWebhookSubscription: (body: CreateWebhookSubscriptionBody) =>
    request<CreateWebhookSubscriptionResultDto>('POST', '/api/webhooks', body),
  updateWebhookSubscription: (id: string, body: UpdateWebhookSubscriptionBody) =>
    request<WebhookSubscriptionDto>('PATCH', `/api/webhooks/${id}`, body),
  deleteWebhookSubscription: (id: string) => request<{ ok: true }>('DELETE', `/api/webhooks/${id}`),
  rotateWebhookSecret: (id: string) =>
    request<RotateWebhookSecretResultDto>('POST', `/api/webhooks/${id}/rotate-secret`),
  testWebhookSubscription: (id: string) =>
    request<{ ok: true; responseStatus: number | null }>('POST', `/api/webhooks/${id}/test`),
  listWebhookDeliveries: (id: string, before?: string | null) =>
    request<WebhookDeliveryAttemptsPageDto>(
      'GET',
      `/api/webhooks/${id}/deliveries${before ? `?before=${encodeURIComponent(before)}` : ''}`
    ),
  redeliverWebhookDelivery: (id: string, outboxId: string) =>
    request<{ ok: true }>('POST', `/api/webhooks/${id}/deliveries/${outboxId}/redeliver`),

  listWorkspaces: () => request<WorkspaceDto[]>('GET', '/api/workspaces'),
  createWorkspace: (body: CreateWorkspaceBody) =>
    request<WorkspaceDto>('POST', '/api/workspaces', body),
  activateWorkspace: (id: string) =>
    request<WorkspaceDto[]>('POST', `/api/workspaces/${id}/activate`),
  updateWorkspace: (id: string, body: UpdateWorkspaceBody) =>
    request<WorkspaceDto>('PATCH', `/api/workspaces/${id}`, body),
  deleteWorkspace: (id: string) => request<WorkspaceDto[]>('DELETE', `/api/workspaces/${id}`),
  listWorkspaceMembers: (id: string) =>
    request<WorkspaceMemberDto[]>('GET', `/api/workspaces/${id}/members`),
  removeWorkspaceMember: (id: string, workspaceUserId: string) =>
    request<{ ok: true }>('DELETE', `/api/workspaces/${id}/members/${workspaceUserId}`),
  updateWorkspaceMemberRole: (
    id: string,
    workspaceUserId: string,
    body: UpdateWorkspaceMemberRoleBody
  ) =>
    request<WorkspaceMemberDto>(
      'PATCH',
      `/api/workspaces/${id}/members/${workspaceUserId}/role`,
      body
    ),
  downloadWorkspaceObjectivesCsv: (id: string) =>
    requestDownload('GET', `/api/workspaces/${id}/objectives.csv`),
  listWorkspaceInvitations: (id: string) =>
    request<WorkspaceInvitationDto[]>('GET', `/api/workspaces/${id}/invitations`),
  inviteWorkspaceMember: (id: string, body: InviteWorkspaceMemberBody) =>
    request<InviteWorkspaceMemberResultDto>('POST', `/api/workspaces/${id}/invitations`, body),
  revokeWorkspaceInvitation: (id: string, invitationId: string) =>
    request<{ ok: true }>('DELETE', `/api/workspaces/${id}/invitations/${invitationId}`),
  acceptWorkspaceInvitation: (body: AcceptWorkspaceInvitationBody) =>
    request<WorkspaceDto>('POST', '/api/invitations/accept', body),

  listProjects: () => request<ProjectDto[]>('GET', '/api/projects'),
  listProjectsForWorkspace: (workspaceId: string) =>
    request<ProjectDto[]>('GET', `/api/workspaces/${workspaceId}/projects`),
  listWorkspaceStatusesForWorkspace: (workspaceId: string) =>
    request<WorkspaceStatusDto[]>('GET', `/api/workspaces/${workspaceId}/statuses`),
  getProject: (id: string) => request<ProjectDto>('GET', `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<ProjectDto>('POST', '/api/projects', body),
  updateProject: (id: string, body: UpdateProjectBody) =>
    request<ProjectDto>('PATCH', `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${id}`),
  reorderProjects: (body: ReorderProjectsBody) =>
    request<ProjectDto[]>('PATCH', `/api/projects/reorder`, body),
  listWorkspaceStatuses: () => request<WorkspaceStatusDto[]>('GET', `/api/workspace/statuses`),
  // A `workspaceId` targets the workspace-scoped routes (any org workspace,
  // authorized there), so the settings modal can manage a non-active
  // workspace's statuses; omit it for the active-workspace legacy routes.
  createWorkspaceStatus: (body: CreateWorkspaceStatusBody, workspaceId?: string | null) =>
    request<WorkspaceStatusDto>(
      'POST',
      workspaceId ? `/api/workspaces/${workspaceId}/statuses` : `/api/workspace/statuses`,
      body
    ),
  updateWorkspaceStatus: (
    statusId: string,
    body: UpdateWorkspaceStatusBody,
    workspaceId?: string | null
  ) =>
    request<WorkspaceStatusDto>(
      'PATCH',
      workspaceId
        ? `/api/workspaces/${workspaceId}/statuses/${statusId}`
        : `/api/workspace/statuses/${statusId}`,
      body
    ),
  deleteWorkspaceStatus: (statusId: string, workspaceId?: string | null) =>
    request<{ ok: true }>(
      'DELETE',
      workspaceId
        ? `/api/workspaces/${workspaceId}/statuses/${statusId}`
        : `/api/workspace/statuses/${statusId}`
    ),
  reorderWorkspaceStatuses: (body: ReorderWorkspaceStatusesBody, workspaceId?: string | null) =>
    request<WorkspaceStatusDto[]>(
      'PATCH',
      workspaceId
        ? `/api/workspaces/${workspaceId}/statuses/reorder`
        : `/api/workspace/statuses/reorder`,
      body
    ),
  listProjectTags: (id: string) => request<ProjectTagDto[]>('GET', `/api/projects/${id}/tags`),
  createProjectTag: (projectId: string, body: CreateProjectTagBody) =>
    request<ProjectTagDto>('POST', `/api/projects/${projectId}/tags`, body),
  updateProjectTag: (projectId: string, tagId: string, body: UpdateProjectTagBody) =>
    request<ProjectTagDto>('PATCH', `/api/projects/${projectId}/tags/${tagId}`, body),
  deleteProjectTag: (projectId: string, tagId: string) =>
    request<{ ok: true }>('DELETE', `/api/projects/${projectId}/tags/${tagId}`),
  listProjectResources: (id: string) =>
    request<ProjectResourceDto[]>('GET', `/api/projects/${id}/resources`),
  createProjectResource: (projectId: string, body: CreateProjectResourceBody) =>
    request<ProjectResourceDto>('POST', `/api/projects/${projectId}/resources`, body),
  updateProjectResource: (projectId: string, resourceId: string, body: UpdateProjectResourceBody) =>
    request<ProjectResourceDto>(
      'PATCH',
      `/api/projects/${projectId}/resources/${resourceId}`,
      body
    ),
  deleteProjectResource: (projectId: string, resourceId: string) =>
    request<{ ok: true }>('DELETE', `/api/projects/${projectId}/resources/${resourceId}`),
  recordTargetResourceObservations: (
    executionTargetId: string,
    body: RecordTargetResourceObservationsBody
  ) =>
    request<RecordTargetResourceObservationsResult>(
      'POST',
      `/api/execution-targets/${executionTargetId}/observations`,
      body
    ),
  recordMissionBranchObservations: (
    executionTargetId: string,
    body: RecordMissionBranchObservationsBody
  ) =>
    request<RecordMissionBranchObservationsResult>(
      'POST',
      `/api/execution-targets/${executionTargetId}/mission-branch-observations`,
      body
    ),
  getProjectRepository: (
    id: string,
    executionTargetId?: string | null,
    resourceKey?: string | null
  ) => {
    const params = new URLSearchParams();
    if (executionTargetId) params.set('executionTargetId', executionTargetId);
    if (resourceKey) params.set('resourceKey', resourceKey);
    const query = params.toString();
    return request<ProjectRepositoryDto>(
      'GET',
      `/api/projects/${id}/repository${query ? `?${query}` : ''}`
    );
  },
  getRunnerStatus: () => request<RunnerQueueStatus>('GET', '/api/runner/status'),
  clearRunnerQueue: (body: { objectiveId?: string; projectId?: string } = {}) =>
    request<{ cleared: number }>('POST', '/api/runner/clear', body),
  listMissions: (projectId: string) =>
    request<MissionDto[]>('GET', `/api/projects/${projectId}/missions`),
  reorderBoardColumn: (projectId: string, body: ReorderBoardColumnBody) =>
    request<MissionDto[]>('PATCH', `/api/projects/${projectId}/board/reorder`, body),
  listWorkspaceMyMissions: () => request<MyMissionsResponse>('GET', `/api/workspace/my-missions`),
  reorderWorkspaceMyMissions: (body: MyMissionReorderRequest) =>
    request<MyMissionsResponse>('PATCH', `/api/workspace/my-missions/order`, body),

  searchMissions: (query: string, options: { projectId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return request<{ missions: MissionDto[] }>('GET', `/api/missions/search?${params.toString()}`);
  },
  getMission: (id: string) => request<MissionDetailDto>('GET', `/api/missions/${id}`),
  createMission: (body: CreateMissionBody) =>
    request<MissionDetailDto>('POST', '/api/missions', body),
  updateMission: (id: string, body: UpdateMissionBody) =>
    request<MissionDetailDto>('PATCH', `/api/missions/${id}`, body),
  getMissionSchedule: (id: string) =>
    request<MissionScheduleDto>('GET', `/api/missions/${id}/schedule`),
  upsertMissionSchedule: (id: string, body: ScheduleInput) =>
    request<MissionScheduleDto>('PUT', `/api/missions/${id}/schedule`, body),
  clearMissionSchedule: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/missions/${id}/schedule`),
  previewMissionSchedule: (body: PreviewScheduleBody) =>
    request<{ dueDatetime: string }>('POST', '/api/missions/schedule/preview', body),
  deleteMission: (id: string) => request<{ ok: true }>('DELETE', `/api/missions/${id}`),
  generateMissionTitle: (id: string) =>
    request<MissionDetailDto>('POST', `/api/missions/${id}/generate-title`),
  generateCommitMessage: (id: string, body?: GenerateCommitMessageBody) =>
    request<GenerateCommitMessageResultDto>(
      'POST',
      `/api/missions/${id}/generate-commit-message`,
      body
    ),
  branchAction: (id: string, body: BranchActionBody) =>
    request<MissionDetailDto>('POST', `/api/missions/${id}/branch/action`, body),
  listMissionBranches: (id: string) =>
    request<MissionBranchListDto>('GET', `/api/missions/${id}/branches`),
  listWorktrees: () => request<WorktreeDto[]>('GET', '/api/worktrees'),
  removeWorktree: (body: RemoveWorktreeBody) =>
    request<PurgeWorktreesResultDto>('POST', '/api/worktrees/remove', body),
  purgeMergedWorktrees: (body?: PurgeMergedWorktreesBody) =>
    request<PurgeWorktreesResultDto>('POST', '/api/worktrees/purge-merged', body),
  listMissionEvents: (id: string) =>
    request<MissionEventDto[]>('GET', `/api/missions/${id}/events`),
  listMissionArtifacts: (id: string) =>
    request<ArtifactDto[]>('GET', `/api/missions/${id}/artifacts`),
  listMissionFileChanges: (id: string) =>
    request<FileChangeDto[]>('GET', `/api/missions/${id}/file-changes`),

  reorderFutureObjectives: (missionId: string, body: ReorderFutureObjectivesBody) =>
    request<ObjectiveDto[]>('PATCH', `/api/missions/${missionId}/objectives/reorder`, body),
  createObjective: (body: CreateObjectiveBody) =>
    request<ObjectiveDto>('POST', '/api/objectives', body),
  updateObjective: (id: string, body: UpdateObjectiveBody) =>
    request<ObjectiveDto>('PATCH', `/api/objectives/${id}`, body),
  deleteObjective: (id: string) => request<{ ok: true }>('DELETE', `/api/objectives/${id}`),
  launchObjective: (id: string, body: LaunchObjectiveBody) =>
    request<ExecutionRequestDto>('POST', `/api/objectives/${id}/launch`, body),
  getObjectivePrompt: (id: string) =>
    request<ObjectivePromptDto>('GET', `/api/objectives/${id}/prompt`),

  listObjectiveAttachments: (objectiveId: string) =>
    request<ObjectiveAttachmentDto[]>('GET', `/api/objectives/${objectiveId}/attachments`),
  /**
   * Upload a single File as an objective attachment. The raw bytes are sent as
   * the request body; the filename rides in a header so the server can record
   * it without multipart parsing (mirrors the image upload service).
   */
  uploadObjectiveAttachment: (objectiveId: string, file: File) =>
    request<ObjectiveAttachmentDto>('POST', `/api/objectives/${objectiveId}/attachments`, file, {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Filename': encodeURIComponent(file.name)
    }),
  deleteObjectiveAttachment: (objectiveId: string, attachmentId: string) =>
    request<ObjectiveAttachmentDto[]>(
      'DELETE',
      `/api/objectives/${objectiveId}/attachments/${attachmentId}`
    ),

  getAgentCatalog: () => request<AgentCatalogDto>('GET', '/api/agent-catalog'),
  updateAgentCatalog: (body: UpdateAgentCatalogBody) =>
    request<AgentCatalogDto>('PUT', '/api/agent-catalog', body),
  refreshAgentCatalog: () => request<AgentCatalogDto>('POST', '/api/agent-catalog/refresh'),
  getLaunchSettings: () => request<LaunchSettingsDto>('GET', '/api/launch-settings'),
  updateAgentLaunchConfig: (agentKey: string, body: UpdateAgentLaunchConfigBody) =>
    request<LaunchSettingsDto>(
      'PATCH',
      `/api/launch-settings/agents/${encodeURIComponent(agentKey)}`,
      body
    ),
  updateTerminalProfile: (body: UpdateTerminalProfileBody) =>
    request<LaunchSettingsDto>('PATCH', '/api/launch-settings/terminal-profile', body),
  updateWorktreeBranchAutomation: (body: UpdateWorktreeBranchAutomationBody) =>
    request<LaunchSettingsDto>('PATCH', '/api/launch-settings/worktree-branch-automation', body),
  getLaunchPreference: (projectId: string) =>
    request<LaunchPreferenceDto>('GET', `/api/projects/${projectId}/launch-preference`),
  updateLaunchPreference: (projectId: string, body: UpdateLaunchPreferenceBody) =>
    request<LaunchPreferenceDto>('PUT', `/api/projects/${projectId}/launch-preference`, body),
  getProjectExecutionTarget: (projectId: string) =>
    request<ProjectExecutionTargetDto>('GET', `/api/projects/${projectId}/execution-target`),
  updateProjectExecutionTarget: (projectId: string, body: UpdateProjectExecutionTargetBody) =>
    request<ProjectExecutionTargetDto>('PUT', `/api/projects/${projectId}/execution-target`, body),
  getWorkspaceExecutionTargets: (workspaceId: string) =>
    request<WorkspaceExecutionTargetDto[]>(
      'GET',
      `/api/workspaces/${workspaceId}/execution-targets`
    ),
  updateWorkspaceExecutionTarget: (
    workspaceId: string,
    executionTargetId: string,
    body: { label: string }
  ) =>
    request<WorkspaceExecutionTargetDto>(
      'PATCH',
      `/api/workspaces/${workspaceId}/execution-targets/${executionTargetId}`,
      body
    ),
  deleteWorkspaceExecutionTarget: (workspaceId: string, executionTargetId: string) =>
    request<{ ok: true }>(
      'DELETE',
      `/api/workspaces/${workspaceId}/execution-targets/${executionTargetId}`
    ),

  // ---- Everhour integration ----------------------------------------------
  getEverhourIntegration: () => request<EverhourIntegrationDto>('GET', '/ext/everhour/integration'),
  setEverhourApiKey: (apiKey: string) =>
    request<EverhourIntegrationDto>('PUT', '/ext/everhour/integration', { apiKey }),
  clearEverhourApiKey: () => request<EverhourIntegrationDto>('DELETE', '/ext/everhour/integration'),
  getProjectEverhourLink: (projectId: string) =>
    request<ProjectEverhourLinkDto>('GET', `/ext/everhour/projects/${projectId}/link`),
  linkProjectEverhour: (projectId: string, body: LinkProjectEverhourBody) =>
    request<ProjectEverhourLinkDto>('PUT', `/ext/everhour/projects/${projectId}/link`, body),
  getProjectEverhour: (projectId: string) =>
    request<ProjectEverhourStateDto>('GET', `/ext/everhour/projects/${projectId}`),
  startProjectTimer: (projectId: string) =>
    request<ProjectEverhourStateDto>('POST', `/ext/everhour/projects/${projectId}/timer/start`),
  stopProjectTimer: (projectId: string) =>
    request<ProjectEverhourStateDto>('POST', `/ext/everhour/projects/${projectId}/timer/stop`),
  addProjectTime: (projectId: string, body: CreateEverhourTimeBody) =>
    request<ProjectEverhourStateDto>('POST', `/ext/everhour/projects/${projectId}/time`, body),
  updateProjectTime: (projectId: string, recordId: string, body: UpdateEverhourTimeBody) =>
    request<ProjectEverhourStateDto>(
      'PATCH',
      `/ext/everhour/projects/${projectId}/time/${recordId}`,
      body
    ),
  deleteProjectTime: (projectId: string, recordId: string) =>
    request<ProjectEverhourStateDto>(
      'DELETE',
      `/ext/everhour/projects/${projectId}/time/${recordId}`
    ),
  getMissionEverhour: (missionId: string) =>
    request<MissionEverhourStateDto>('GET', `/ext/everhour/missions/${missionId}`),
  startMissionTimer: (missionId: string) =>
    request<MissionEverhourStateDto>('POST', `/ext/everhour/missions/${missionId}/timer/start`),
  stopMissionTimer: (missionId: string) =>
    request<MissionEverhourStateDto>('POST', `/ext/everhour/missions/${missionId}/timer/stop`),
  addMissionTime: (missionId: string, body: CreateEverhourTimeBody) =>
    request<MissionEverhourStateDto>('POST', `/ext/everhour/missions/${missionId}/time`, body),
  updateMissionTime: (missionId: string, recordId: string, body: UpdateEverhourTimeBody) =>
    request<MissionEverhourStateDto>(
      'PATCH',
      `/ext/everhour/missions/${missionId}/time/${recordId}`,
      body
    ),
  deleteMissionTime: (missionId: string, recordId: string) =>
    request<MissionEverhourStateDto>(
      'DELETE',
      `/ext/everhour/missions/${missionId}/time/${recordId}`
    ),

  // ---- GitHub integration ------------------------------------------------
  getGitHubIntegration: () => request<GitHubIntegrationDto>('GET', '/ext/github/integration'),
  beginGitHubInstall: () => request<GitHubInstallUrlDto>('POST', '/ext/github/install'),
  disconnectGitHub: () => request<GitHubIntegrationDto>('DELETE', '/ext/github/integration'),
  listGitHubRepos: (query?: string) =>
    request<GitHubRepoSummaryDto[]>(
      'GET',
      `/ext/github/repos${query ? `?q=${encodeURIComponent(query)}` : ''}`
    ),
  getProjectGitHubLink: (projectId: string) =>
    request<ProjectGitHubLinkDto>('GET', `/ext/github/projects/${projectId}/link`),
  linkProjectGitHub: (projectId: string, body: LinkProjectGitHubBody) =>
    request<ProjectGitHubLinkDto>('PUT', `/ext/github/projects/${projectId}/link`, body),
  getMissionGitHubPullRequest: (missionId: string) =>
    request<GitHubPullRequestDto | null>('GET', `/ext/github/missions/${missionId}/pull-request`),
  createMissionGitHubPullRequest: (missionId: string, body: CreateGitHubPullRequestBody = {}) =>
    request<GitHubPullRequestDto>('POST', `/ext/github/missions/${missionId}/pull-request`, body),

  /** Dev-only loopback SQLite proxy for checkout-local capabilities in plain browser. */
  invokeLocalTarget: (call: LocalTargetBridgeCall) =>
    request<CapabilityResult<unknown>>('POST', '/api/local-target/invoke', call)
};
