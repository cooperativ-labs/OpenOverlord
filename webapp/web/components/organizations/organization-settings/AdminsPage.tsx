import { useQueries } from '@tanstack/react-query';
import { Loader2, UserMinus, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { api } from '@/lib/api';
import {
  keys,
  useAddOrganizationAdmin,
  useOrganizationAdmins,
  useRemoveOrganizationAdmin
} from '@/lib/queries';

import type {
  OrganizationDto,
  WorkspaceDto,
  WorkspaceMemberDto
} from '../../../../shared/contract.ts';

type AdminsPageProps = {
  organization: OrganizationDto;
  workspaces: WorkspaceDto[];
  isOrgAdmin: boolean;
  partialAdmin: boolean;
};

type CandidateMember = WorkspaceMemberDto & { workspaceName: string };

export function AdminsPage({
  organization,
  workspaces,
  isOrgAdmin,
  partialAdmin
}: AdminsPageProps) {
  const admins = useOrganizationAdmins(isOrgAdmin ? organization.id : null);
  const addAdmin = useAddOrganizationAdmin(organization.id);
  const removeAdmin = useRemoveOrganizationAdmin(organization.id);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [pendingRemoveUserId, setPendingRemoveUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const memberQueries = useQueries({
    queries: workspaces.map(workspace => ({
      queryKey: keys.workspaceMembers(workspace.id),
      queryFn: () => api.listWorkspaceMembers(workspace.id)
    }))
  });

  const candidates = useMemo(() => {
    const byUserId = new Map<string, CandidateMember>();
    workspaces.forEach((workspace, index) => {
      for (const member of memberQueries[index]?.data ?? []) {
        if (!byUserId.has(member.userId)) {
          byUserId.set(member.userId, { ...member, workspaceName: workspace.name });
        }
      }
    });
    return [...byUserId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [memberQueries, workspaces]);

  const adminRows = admins.data ?? [];
  const isLastAdmin = adminRows.length <= 1;

  async function handleAddAdmin() {
    if (!selectedUserId) return;
    setActionError(null);
    try {
      await addAdmin.mutateAsync({ userId: selectedUserId });
      setSelectedUserId('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to add organization admin.');
    }
  }

  async function handleRemoveAdmin() {
    if (!pendingRemoveUserId) return;
    setActionError(null);
    try {
      await removeAdmin.mutateAsync(pendingRemoveUserId);
      setPendingRemoveUserId(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Failed to remove organization admin.'
      );
    }
  }

  function handleSelectCandidate(value: string | null) {
    setSelectedUserId(value ?? '');
  }

  if (!isOrgAdmin) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Admins</h2>
          <p className="text-sm text-muted-foreground">
            Organization admins have admin access to every workspace in this organization.
          </p>
        </div>
        {partialAdmin ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            You can view organization settings because you are a workspace admin, but only full
            organization admins can manage the admin list. Ask an organization admin to grant you
            admin access in every workspace, or use the repair action once you become a full org
            admin.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can manage this list.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Admins</h2>
        <p className="text-sm text-muted-foreground">
          Organization admins are admins of every workspace in this organization.
        </p>
      </div>

      <div className="max-w-lg space-y-3 rounded-lg border border-border bg-card p-4">
        <Label htmlFor="add-organization-admin">Add admin</Label>
        <div className="flex gap-2">
          <Select value={selectedUserId} onValueChange={handleSelectCandidate}>
            <SelectTrigger id="add-organization-admin" className="h-8">
              <SelectValue placeholder="Choose a member" />
            </SelectTrigger>
            <SelectContent>
              {candidates
                .filter(candidate => !adminRows.some(admin => admin.userId === candidate.userId))
                .map(candidate => (
                  <SelectItem key={candidate.userId} value={candidate.userId}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={!selectedUserId || addAdmin.isPending}
            onClick={() => void handleAddAdmin()}
          >
            <UserPlus className="size-3.5" />
            Add
          </Button>
        </div>
      </div>

      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}

      {admins.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      ) : null}

      {adminRows.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Admin</th>
                <th className="px-3 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {adminRows.map(admin => (
                <tr key={admin.userId} className="border-t">
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <span>{admin.displayName}</span>
                      {admin.email ? (
                        <span className="text-xs text-muted-foreground">{admin.email}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-destructive hover:text-destructive"
                      disabled={isLastAdmin}
                      onClick={() => setPendingRemoveUserId(admin.userId)}
                    >
                      <UserMinus className="size-3.5" />
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog
        open={pendingRemoveUserId !== null}
        onOpenChange={open => !open && setPendingRemoveUserId(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove organization admin?</DialogTitle>
            <DialogDescription>
              They will be demoted to member in every workspace of this organization.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingRemoveUserId(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleRemoveAdmin()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
