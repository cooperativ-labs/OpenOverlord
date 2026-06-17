import type {
  AgentCatalogDto,
  ArtifactDto,
  CompleteInitialSetupBody,
  CreateObjectiveBody,
  CreateProjectBody,
  CreateProjectStatusBody,
  CreateTicketBody,
  CreateUserTokenBody,
  CreateUserTokenResultDto,
  CreateWorkspaceBody,
  ExecutionRequestDto,
  FileChangeDto,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  LaunchSettingsDto,
  ObjectiveAttachmentDto,
  ObjectiveDto,
  ObjectivePromptDto,
  ProfileDto,
  ProjectDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectStatusDto,
  ReorderBoardColumnBody,
  ReorderFutureObjectivesBody,
  ReorderProjectStatusesBody,
  StoredImageDto,
  TicketDetailDto,
  TicketDto,
  TicketEventDto,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateObjectiveBody,
  UpdateProfileBody,
  UpdateProjectBody,
  UpdateProjectStatusBody,
  UpdateTerminalProfileBody,
  UpdateTicketBody,
  UpdateUserTokenBody,
  UpdateWorkspaceBody,
  UserTokenDto,
  WorkspaceDto,
  WorkspaceMemberDto
} from '../../shared/contract.ts';

export interface Meta {
  workspace: { id: string; slug: string; name: string };
  /** True while the seeded first workspace still needs its initial setup step. */
  needsSetup: boolean;
  databasePath: string;
  web: { host: string; port: number; url: string };
  sqlStudio: { enabled: boolean; url: string | null };
  capabilities: Record<string, boolean>;
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
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: isRaw
      ? rawHeaders
      : body !== undefined
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body: isRaw ? (body as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: string; detail?: string };
      message = payload.error ?? message;
      if (payload.detail) message += ` — ${payload.detail}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

  listProjects: () => request<ProjectDto[]>('GET', '/api/projects'),
  getProject: (id: string) => request<ProjectDto>('GET', `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<ProjectDto>('POST', '/api/projects', body),
  updateProject: (id: string, body: UpdateProjectBody) =>
    request<ProjectDto>('PATCH', `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${id}`),
  listProjectStatuses: (id: string) =>
    request<ProjectStatusDto[]>('GET', `/api/projects/${id}/statuses`),
  createProjectStatus: (projectId: string, body: CreateProjectStatusBody) =>
    request<ProjectStatusDto>('POST', `/api/projects/${projectId}/statuses`, body),
  updateProjectStatus: (projectId: string, statusId: string, body: UpdateProjectStatusBody) =>
    request<ProjectStatusDto>('PATCH', `/api/projects/${projectId}/statuses/${statusId}`, body),
  deleteProjectStatus: (projectId: string, statusId: string) =>
    request<{ ok: true }>('DELETE', `/api/projects/${projectId}/statuses/${statusId}`),
  reorderProjectStatuses: (projectId: string, body: ReorderProjectStatusesBody) =>
    request<ProjectStatusDto[]>('PATCH', `/api/projects/${projectId}/statuses/reorder`, body),
  listProjectResources: (id: string) =>
    request<ProjectResourceDto[]>('GET', `/api/projects/${id}/resources`),
  getProjectRepository: (id: string, executionTargetId?: string | null) => {
    const params = new URLSearchParams();
    if (executionTargetId) params.set('executionTargetId', executionTargetId);
    const query = params.toString();
    return request<ProjectRepositoryDto>(
      'GET',
      `/api/projects/${id}/repository${query ? `?${query}` : ''}`
    );
  },
  listTickets: (projectId: string) =>
    request<TicketDto[]>('GET', `/api/projects/${projectId}/tickets`),
  reorderBoardColumn: (projectId: string, body: ReorderBoardColumnBody) =>
    request<TicketDto[]>('PATCH', `/api/projects/${projectId}/board/reorder`, body),

  searchTickets: (query: string, options: { projectId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return request<{ tickets: TicketDto[] }>('GET', `/api/tickets/search?${params.toString()}`);
  },
  getTicket: (id: string) => request<TicketDetailDto>('GET', `/api/tickets/${id}`),
  createTicket: (body: CreateTicketBody) => request<TicketDetailDto>('POST', '/api/tickets', body),
  updateTicket: (id: string, body: UpdateTicketBody) =>
    request<TicketDetailDto>('PATCH', `/api/tickets/${id}`, body),
  deleteTicket: (id: string) => request<{ ok: true }>('DELETE', `/api/tickets/${id}`),
  listTicketEvents: (id: string) => request<TicketEventDto[]>('GET', `/api/tickets/${id}/events`),
  listTicketArtifacts: (id: string) =>
    request<ArtifactDto[]>('GET', `/api/tickets/${id}/artifacts`),
  listTicketFileChanges: (id: string) =>
    request<FileChangeDto[]>('GET', `/api/tickets/${id}/file-changes`),

  reorderFutureObjectives: (ticketId: string, body: ReorderFutureObjectivesBody) =>
    request<ObjectiveDto[]>('PATCH', `/api/tickets/${ticketId}/objectives/reorder`, body),
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
  getLaunchPreference: (projectId: string) =>
    request<LaunchPreferenceDto>('GET', `/api/projects/${projectId}/launch-preference`),
  updateLaunchPreference: (projectId: string, body: UpdateLaunchPreferenceBody) =>
    request<LaunchPreferenceDto>('PUT', `/api/projects/${projectId}/launch-preference`, body)
};
