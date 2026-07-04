import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { useProfile } from '@/lib/queries';

import type { WorkspaceDto } from '../../../shared/contract.ts';

/**
 * Derives org-admin visibility from workspace membership rows (the server keeps
 * org admin as ADMIN in every constituent workspace). `canView` matches
 * `canViewOrganizationSettings`; `isOrgAdmin` matches `isOrganizationAdmin`.
 */
export function useOrganizationAdminStatus({
  organizationId,
  workspaces
}: {
  organizationId: string | null;
  workspaces: WorkspaceDto[];
}) {
  const profile = useProfile();
  const operatorUserId = profile.data?.userId ?? null;

  const memberQueries = useQueries({
    queries: workspaces.map(workspace => ({
      queryKey: keys.workspaceMembers(workspace.id),
      queryFn: () => api.listWorkspaceMembers(workspace.id),
      enabled: Boolean(organizationId)
    }))
  });

  const isLoading = memberQueries.some(query => query.isLoading);
  const isError = memberQueries.some(query => query.isError);

  return useMemo(() => {
    if (!organizationId || !operatorUserId || workspaces.length === 0) {
      return {
        isLoading,
        isError,
        canView: false,
        isOrgAdmin: false,
        partialAdmin: false,
        adminWorkspaceIds: [] as string[],
        nonAdminWorkspaceIds: [] as string[]
      };
    }

    const adminWorkspaceIds: string[] = [];
    const nonAdminWorkspaceIds: string[] = [];

    workspaces.forEach((workspace, index) => {
      const members = memberQueries[index]?.data ?? [];
      const operator = members.find(member => member.userId === operatorUserId);
      if (operator?.isAdmin) {
        adminWorkspaceIds.push(workspace.id);
      } else {
        nonAdminWorkspaceIds.push(workspace.id);
      }
    });

    const canView = adminWorkspaceIds.length > 0;
    const isOrgAdmin = workspaces.length > 0 && adminWorkspaceIds.length === workspaces.length;
    const partialAdmin = canView && !isOrgAdmin;

    return {
      isLoading,
      isError,
      canView,
      isOrgAdmin,
      partialAdmin,
      adminWorkspaceIds,
      nonAdminWorkspaceIds
    };
  }, [isError, isLoading, memberQueries, operatorUserId, organizationId, workspaces]);
}
