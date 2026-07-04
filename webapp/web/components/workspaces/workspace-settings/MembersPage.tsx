import { Loader2, Mail, RotateCw, Shield, ShieldOff, UserMinus, X } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  useInviteWorkspaceMember,
  useRemoveWorkspaceMember,
  useRevokeWorkspaceInvitation,
  useUpdateWorkspaceMemberRole,
  useWorkspaceInvitations,
  useWorkspaceMembers
} from '@/lib/queries';

type WorkspaceRoleKey = 'ADMIN' | 'MANAGER' | 'MEMBER';

type MembersPageProps = {
  workspaceId: string;
};

type PendingAction =
  | { type: 'remove-member'; workspaceUserId: string; label: string }
  | { type: 'set-role'; workspaceUserId: string; label: string; roleKey: WorkspaceRoleKey }
  | { type: 'revoke-invitation'; invitationId: string; label: string };

function memberRoleLabel(member: { isAdmin: boolean; roleKeys: string[] }): string {
  if (member.isAdmin) return 'Admin';
  if (member.roleKeys.includes('MANAGER')) return 'Manager';
  return 'Member';
}

export function MembersPage({ workspaceId }: MembersPageProps) {
  const members = useWorkspaceMembers(workspaceId);
  const memberRows = members.data ?? [];
  const operator = memberRows.find(member => member.isOperator);
  const operatorIsAdmin = operator?.isAdmin ?? false;
  const operatorIsManager = !operatorIsAdmin && (operator?.roleKeys.includes('MANAGER') ?? false);
  const canManageMembers = operatorIsAdmin || operatorIsManager;
  const invitations = useWorkspaceInvitations(workspaceId);
  const inviteMember = useInviteWorkspaceMember(workspaceId);
  const revokeInvitation = useRevokeWorkspaceInvitation(workspaceId);
  const removeMember = useRemoveWorkspaceMember(workspaceId);
  const updateMemberRole = useUpdateWorkspaceMemberRole(workspaceId);

  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState<WorkspaceRoleKey>('MEMBER');
  const [inviteState, setInviteState] = useState<ButtonLoadingState>('default');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [manualAcceptUrl, setManualAcceptUrl] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingInvitations = (invitations.data ?? []).filter(inv => inv.status === 'pending');

  function canChangeMember(member: { isAdmin: boolean; roleKeys: string[]; isOperator: boolean }) {
    if (!canManageMembers || member.isOperator) return false;
    if (operatorIsManager && member.isAdmin) return false;
    return true;
  }

  function nextRoleForMember(member: { isAdmin: boolean; roleKeys: string[] }): WorkspaceRoleKey {
    if (member.isAdmin) return 'MEMBER';
    if (member.roleKeys.includes('MANAGER')) return 'ADMIN';
    return operatorIsManager ? 'MANAGER' : 'ADMIN';
  }

  async function handleInvite() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviteState('loading');
    setInviteError(null);
    setManualAcceptUrl(null);
    try {
      const result = await inviteMember.mutateAsync({ email: trimmed, roleKey });
      // No email provider is configured on this instance — the invite was
      // created but never sent, so surface the link for the admin to share.
      if (result.acceptUrl) setManualAcceptUrl(result.acceptUrl);
      setEmail('');
      setInviteState('success');
    } catch (error) {
      setInviteState('error');
      setInviteError(error instanceof Error ? error.message : 'Failed to send invitation.');
    }
  }

  async function handleResend(invitationEmail: string, invitationRole: string) {
    setActionError(null);
    try {
      await inviteMember.mutateAsync({ email: invitationEmail, roleKey: invitationRole });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to resend invitation.');
    }
  }

  async function handleConfirmAction() {
    if (!pendingAction) return;
    setActionError(null);
    try {
      if (pendingAction.type === 'remove-member') {
        await removeMember.mutateAsync(pendingAction.workspaceUserId);
      } else if (pendingAction.type === 'set-role') {
        await updateMemberRole.mutateAsync({
          workspaceUserId: pendingAction.workspaceUserId,
          body: { roleKey: pendingAction.roleKey }
        });
      } else {
        await revokeInvitation.mutateAsync(pendingAction.invitationId);
      }
      setPendingAction(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'That action could not be completed.'
      );
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-medium">Members</h2>
        <p className="text-sm text-muted-foreground">
          People and service accounts with access to this workspace.
        </p>
      </div>

      {canManageMembers ? (
        <div className="max-w-lg space-y-3 rounded-lg border border-border bg-card p-4">
          <Label htmlFor="invite-member-email">Invite by email</Label>
          <div className="flex gap-2">
            <Input
              id="invite-member-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="h-8"
              disabled={inviteState === 'loading'}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleInvite();
              }}
            />
            <Select value={roleKey} onValueChange={value => setRoleKey(value as WorkspaceRoleKey)}>
              <SelectTrigger id="invite-member-role" className="h-8 w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="MANAGER">Manager</SelectItem>
                {operatorIsAdmin ? <SelectItem value="ADMIN">Admin</SelectItem> : null}
              </SelectContent>
            </Select>
            <LoadingButton
              buttonState={inviteState}
              setButtonState={setInviteState}
              text={
                <>
                  <Mail className="h-3.5 w-3.5" />
                  Invite
                </>
              }
              loadingText="Sending…"
              successText="Sent"
              errorText="Retry"
              reset
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5"
              onClick={handleInvite}
              disabled={!email.trim()}
            />
          </div>
          {inviteError ? <p className="text-xs text-destructive">{inviteError}</p> : null}
          {manualAcceptUrl ? (
            <p className="break-all text-xs text-muted-foreground">
              No email provider is configured — share this link directly:{' '}
              <span className="font-mono">{manualAcceptUrl}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}

      {members.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      ) : null}

      {members.isError ? (
        <p className="text-xs text-destructive">
          {members.error instanceof Error ? members.error.message : 'Failed to load members.'}
        </p>
      ) : null}

      {!members.isLoading && memberRows.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Member</th>
                <th className="px-3 py-2 text-left font-medium">Kind</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-left font-medium">Joined</th>
                {canManageMembers ? (
                  <th className="px-3 py-2 text-right font-medium">&nbsp;</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {memberRows.map(member => (
                <tr key={member.workspaceUserId} className="border-t">
                  <td className="px-3 py-2">
                    <div className="flex flex-col">
                      <span className="text-sm">
                        {member.displayName}
                        {member.isOperator ? (
                          <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                        ) : null}
                      </span>
                      {member.email || member.handle ? (
                        <span className="text-xs text-muted-foreground">
                          {member.email ?? `@${member.handle}`}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="text-xs capitalize">
                      {member.kind}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={member.isAdmin ? 'default' : 'secondary'} className="text-xs">
                      {memberRoleLabel(member)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </td>
                  {canManageMembers ? (
                    <td className="px-3 py-2 text-right">
                      {canChangeMember(member) ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5"
                            onClick={() =>
                              setPendingAction({
                                type: 'set-role',
                                workspaceUserId: member.workspaceUserId,
                                label: member.displayName,
                                roleKey: nextRoleForMember(member)
                              })
                            }
                          >
                            {member.isAdmin ? (
                              <ShieldOff className="h-3.5 w-3.5" />
                            ) : (
                              <Shield className="h-3.5 w-3.5" />
                            )}
                            {member.isAdmin ? 'Demote' : 'Promote'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-destructive hover:text-destructive"
                            onClick={() =>
                              setPendingAction({
                                type: 'remove-member',
                                workspaceUserId: member.workspaceUserId,
                                label: member.displayName
                              })
                            }
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!members.isLoading && !members.isError && memberRows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No members found.</p>
      ) : null}

      {canManageMembers && pendingInvitations.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Pending invitations</h3>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">Expires</th>
                  <th className="px-3 py-2 text-right font-medium">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map(invitation => (
                  <tr key={invitation.id} className="border-t">
                    <td className="px-3 py-2">{invitation.email}</td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className="text-xs capitalize">
                        {invitation.roleKey}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(invitation.expiresAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5"
                          onClick={() => void handleResend(invitation.email, invitation.roleKey)}
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                          Resend
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1.5 text-destructive hover:text-destructive"
                          onClick={() =>
                            setPendingAction({
                              type: 'revoke-invitation',
                              invitationId: invitation.id,
                              label: invitation.email
                            })
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Dialog open={pendingAction !== null} onOpenChange={open => !open && setPendingAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.type === 'remove-member'
                ? `Remove ${pendingAction.label}?`
                : pendingAction?.type === 'set-role'
                  ? pendingAction.roleKey === 'ADMIN'
                    ? `Promote ${pendingAction.label}?`
                    : `Demote ${pendingAction.label}?`
                  : `Revoke invitation to ${pendingAction?.label}?`}
            </DialogTitle>
            <DialogDescription>
              {pendingAction?.type === 'remove-member'
                ? 'They will lose access to this workspace immediately.'
                : pendingAction?.type === 'set-role'
                  ? pendingAction.roleKey === 'ADMIN'
                    ? 'They will gain workspace administrator permissions.'
                    : 'They will keep member access but lose administrator permissions.'
                  : 'The invite link will stop working.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleConfirmAction()}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
