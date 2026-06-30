import type { LocalTargetBridgeCall } from '../../packages/core/service/local-target/desktop-bridge.ts';
import type { CapabilityResult } from '../../packages/core/service/local-target/types.ts';
import type {
  AgentCatalogDto,
  ArtifactDto,
  BranchActionBody,
  CompleteInitialSetupBody,
  CreateEverhourTimeBody,
  CreateMissionBody,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectResourceBody,
  CreateProjectTagBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  CreateWorkspaceBody,
  CreateWorkspaceStatusBody,
  EverhourIntegrationDto,
  ExecutionRequestDto,
  FileChangeDto,
  GenerateCommitMessageBody,
  GenerateCommitMessageResultDto,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  LaunchSettingsDto,
  LinkProjectEverhourBody,
  MissionBranchListDto,
  MissionDetailDto,
  MissionDto,
  MissionEventDto,
  MissionEverhourStateDto,
  MyMissionReorderRequest,
  MyMissionsResponse,
  ObjectiveAttachmentDto,
  ObjectiveDto,
  ObjectivePromptDto,
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
  ReorderWorkspaceStatusesBody,
  StoredImageDto,
  UpdateAgentLaunchConfigBody,
  UpdateEverhourTimeBody,
  UpdateLaunchPreferenceBody,
  UpdateMissionBody,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectExecutionTargetBody,
  UpdateProjectResourceBody,
  UpdateProjectTagBody,
  UpdateTerminalProfileBody,
  UpdateUserTokenBody,
  UpdateWorkspaceBody,
  UpdateWorkspaceStatusBody,
  UpdateWorktreeBranchAutomationBody,
  UserTokenDto,
  WorkspaceDto,
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
}

export interface Meta {
  workspace: { id: string; slug: string; name: string };
  /** True while the seeded first workspace still needs its initial setup step. */
  needsSetup: boolean;
  databasePath: string;
  web: { host: string; port: number; url: string };
  sqlStudio: { enabled: boolean; url: string | null };
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
  completeSetup: (body: CompleteInitialSetupBody) =>
    request<WorkspaceDto>('POST', '/api/setup', body),

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
  downloadWorkspaceObjectivesCsv: (id: string) =>
    requestDownload('GET', `/api/workspaces/${id}/objectives.csv`),

  listProjects: () => request<ProjectDto[]>('GET', '/api/projects'),
  getProject: (id: string) => request<ProjectDto>('GET', `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<ProjectDto>('POST', '/api/projects', body),
  updateProject: (id: string, body: UpdateProjectBody) =>
    request<ProjectDto>('PATCH', `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${id}`),
  listWorkspaceStatuses: () => request<WorkspaceStatusDto[]>('GET', `/api/workspace/statuses`),
  createWorkspaceStatus: (body: CreateWorkspaceStatusBody) =>
    request<WorkspaceStatusDto>('POST', `/api/workspace/statuses`, body),
  updateWorkspaceStatus: (statusId: string, body: UpdateWorkspaceStatusBody) =>
    request<WorkspaceStatusDto>('PATCH', `/api/workspace/statuses/${statusId}`, body),
  deleteWorkspaceStatus: (statusId: string) =>
    request<{ ok: true }>('DELETE', `/api/workspace/statuses/${statusId}`),
  reorderWorkspaceStatuses: (body: ReorderWorkspaceStatusesBody) =>
    request<WorkspaceStatusDto[]>('PATCH', `/api/workspace/statuses/reorder`, body),
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
  getProjectRepository: (id: string, executionTargetId?: string | null) => {
    const params = new URLSearchParams();
    if (executionTargetId) params.set('executionTargetId', executionTargetId);
    const query = params.toString();
    return request<ProjectRepositoryDto>(
      'GET',
      `/api/projects/${id}/repository${query ? `?${query}` : ''}`
    );
  },
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

  // ---- Everhour integration ----------------------------------------------
  getEverhourIntegration: () =>
    request<EverhourIntegrationDto>('GET', '/api/integrations/everhour'),
  setEverhourApiKey: (apiKey: string) =>
    request<EverhourIntegrationDto>('PUT', '/api/integrations/everhour', { apiKey }),
  clearEverhourApiKey: () =>
    request<EverhourIntegrationDto>('DELETE', '/api/integrations/everhour'),
  linkProjectEverhour: (projectId: string, body: LinkProjectEverhourBody) =>
    request<ProjectDto>('PUT', `/api/projects/${projectId}/everhour-link`, body),
  getMissionEverhour: (missionId: string) =>
    request<MissionEverhourStateDto>('GET', `/api/missions/${missionId}/everhour`),
  startMissionTimer: (missionId: string) =>
    request<MissionEverhourStateDto>('POST', `/api/missions/${missionId}/everhour/timer/start`),
  stopMissionTimer: (missionId: string) =>
    request<MissionEverhourStateDto>('POST', `/api/missions/${missionId}/everhour/timer/stop`),
  addMissionTime: (missionId: string, body: CreateEverhourTimeBody) =>
    request<MissionEverhourStateDto>('POST', `/api/missions/${missionId}/everhour/time`, body),
  updateMissionTime: (missionId: string, recordId: string, body: UpdateEverhourTimeBody) =>
    request<MissionEverhourStateDto>(
      'PATCH',
      `/api/missions/${missionId}/everhour/time/${recordId}`,
      body
    ),
  deleteMissionTime: (missionId: string, recordId: string) =>
    request<MissionEverhourStateDto>(
      'DELETE',
      `/api/missions/${missionId}/everhour/time/${recordId}`
    ),

  /** Dev-only loopback SQLite proxy for checkout-local capabilities in plain browser. */
  invokeLocalTarget: (call: LocalTargetBridgeCall) =>
    request<CapabilityResult<unknown>>('POST', '/api/local-target/invoke', call)
};
