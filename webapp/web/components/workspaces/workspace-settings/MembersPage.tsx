import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useWorkspaceMembers } from '@/lib/queries';

type MembersPageProps = {
  workspaceId: string;
};

export function MembersPage({ workspaceId }: MembersPageProps) {
  const members = useWorkspaceMembers(workspaceId);

  const rows = members.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Members</h2>
        <p className="text-sm text-muted-foreground">
          People and service accounts with access to this workspace. This local build runs as a
          single trusted operator — inviting and managing members is a hosted feature.
        </p>
      </div>

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

      {!members.isLoading && rows.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Member</th>
                <th className="px-3 py-2 text-left font-medium">Kind</th>
                <th className="px-3 py-2 text-left font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(member => (
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
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!members.isLoading && !members.isError && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No members found.</p>
      ) : null}
    </div>
  );
}
