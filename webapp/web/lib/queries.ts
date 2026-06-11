import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateObjectiveBody,
  CreateProjectBody,
  CreateTicketBody,
  SqliteBrowserQueryResultDto,
  StatusType,
  TicketDto,
  UpdateObjectiveBody,
  UpdateProjectBody,
  UpdateTicketBody
} from '../../shared/contract.ts';

import { api } from './api.ts';

export const keys = {
  meta: ['meta'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectStatuses: (id: string) => ['project', id, 'statuses'] as const,
  projectResources: (id: string) => ['project', id, 'resources'] as const,
  projectRepository: (id: string, executionTargetId: string | null) =>
    ['project', id, 'repository', executionTargetId ?? 'primary'] as const,
  tickets: (projectId: string) => ['project', projectId, 'tickets'] as const,
  ticket: (id: string) => ['ticket', id] as const,
  sqliteTables: ['sqlite-browser', 'tables'] as const,
  sqliteTableData: (tableName: string, limit: number, offset: number) =>
    ['sqlite-browser', 'table', tableName, limit, offset] as const
};

// Realtime invalidation is global, but mutations also invalidate eagerly so the
// originating user sees their change instantly rather than after the next poll.
function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries();
}

// ---- Queries -------------------------------------------------------------

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: api.meta });

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.listProjects });

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) });

export const useProjectStatuses = (id: string) =>
  useQuery({ queryKey: keys.projectStatuses(id), queryFn: () => api.listProjectStatuses(id) });

export const useProjectResources = (id: string) =>
  useQuery({ queryKey: keys.projectResources(id), queryFn: () => api.listProjectResources(id) });

export const useProjectRepository = (id: string, executionTargetId: string | null) =>
  useQuery({
    queryKey: keys.projectRepository(id, executionTargetId),
    queryFn: () => api.getProjectRepository(id, executionTargetId)
  });

export const useTickets = (projectId: string) =>
  useQuery({ queryKey: keys.tickets(projectId), queryFn: () => api.listTickets(projectId) });

export const useTicket = (id: string) =>
  useQuery({ queryKey: keys.ticket(id), queryFn: () => api.getTicket(id) });

export const useSqliteTables = () =>
  useQuery({ queryKey: keys.sqliteTables, queryFn: api.listSqliteTables });

export const useSqliteTableData = (tableName: string | null, limit: number, offset: number) =>
  useQuery({
    queryKey: keys.sqliteTableData(tableName ?? '__none__', limit, offset),
    queryFn: () => api.getSqliteTableData(tableName ?? '', limit, offset),
    enabled: Boolean(tableName)
  });

// ---- Mutations -----------------------------------------------------------

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

export function useRunSqliteQuery() {
  return useMutation({
    mutationFn: (sql: string): Promise<SqliteBrowserQueryResultDto> => api.runSqliteQuery(sql)
  });
}
