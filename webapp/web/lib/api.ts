import type {
  CreateObjectiveBody,
  CreateProjectBody,
  CreateTicketBody,
  ObjectiveDto,
  ProjectDto,
  ProjectRepositoryDto,
  ProjectResourceDto,
  ProjectStatusDto,
  ReorderBoardColumnBody,
  TicketDetailDto,
  TicketDto,
  UpdateObjectiveBody,
  UpdateProjectBody,
  UpdateTicketBody
} from '../../shared/contract.ts';

export interface Meta {
  workspace: { id: string; slug: string; name: string };
  databasePath: string;
  capabilities: Record<string, boolean>;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
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

  listProjects: () => request<ProjectDto[]>('GET', '/api/projects'),
  getProject: (id: string) => request<ProjectDto>('GET', `/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => request<ProjectDto>('POST', '/api/projects', body),
  updateProject: (id: string, body: UpdateProjectBody) =>
    request<ProjectDto>('PATCH', `/api/projects/${id}`, body),
  listProjectStatuses: (id: string) =>
    request<ProjectStatusDto[]>('GET', `/api/projects/${id}/statuses`),
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

  getTicket: (id: string) => request<TicketDetailDto>('GET', `/api/tickets/${id}`),
  createTicket: (body: CreateTicketBody) => request<TicketDetailDto>('POST', '/api/tickets', body),
  updateTicket: (id: string, body: UpdateTicketBody) =>
    request<TicketDetailDto>('PATCH', `/api/tickets/${id}`, body),
  deleteTicket: (id: string) => request<{ ok: true }>('DELETE', `/api/tickets/${id}`),

  createObjective: (body: CreateObjectiveBody) =>
    request<ObjectiveDto>('POST', '/api/objectives', body),
  updateObjective: (id: string, body: UpdateObjectiveBody) =>
    request<ObjectiveDto>('PATCH', `/api/objectives/${id}`, body),
  deleteObjective: (id: string) => request<{ ok: true }>('DELETE', `/api/objectives/${id}`)
};
