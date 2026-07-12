import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { useWorkspaceExecutionTargets } from '@/lib/queries';

function targetStatusLabel(status: string, reachable: boolean): string {
  if (status !== 'active') return status;
  return reachable ? 'online' : 'offline';
}

export function ExecutionTargetsPage({ workspaceId }: { workspaceId: string }) {
  const targets = useWorkspaceExecutionTargets(workspaceId);

  if (targets.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading execution targets…</p>;
  }

  if (targets.isError) {
    return (
      <p className="text-sm text-destructive">
        {targets.error instanceof Error
          ? targets.error.message
          : 'Failed to load execution targets.'}
      </p>
    );
  }

  if (!targets.data?.length) {
    return (
      <div className="space-y-2">
        <h2 className="text-base font-medium">Execution targets</h2>
        <p className="text-sm text-muted-foreground">
          No execution targets have connected to this workspace yet. A target appears when a
          workspace member configures a local runner or a virtual gateway registers here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-medium">Execution targets</h2>
        <p className="text-sm text-muted-foreground">
          Targets belong to this workspace. Expand one to see who can use it and its current
          availability; connection details and credentials stay private to the target.
        </p>
      </div>

      <Accordion multiple className="overflow-hidden rounded-lg border px-4">
        {targets.data.map(target => {
          const sharedWithOthers = target.activeMemberAccessCount > 1;
          return (
            <AccordionItem key={target.id} value={target.id}>
              <AccordionTrigger className="hover:no-underline">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{target.label}</span>
                  <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {target.type}
                  </span>
                  <span
                    className={
                      target.reachable
                        ? 'text-xs font-normal text-emerald-600 dark:text-emerald-400'
                        : 'text-xs font-normal text-muted-foreground'
                    }
                  >
                    {targetStatusLabel(target.status, target.reachable)}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="pt-2">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="space-y-1">
                    <dt className="text-xs text-muted-foreground">Owner</dt>
                    <dd>{target.ownerDisplayName ?? 'Workspace-managed target'}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-xs text-muted-foreground">Access</dt>
                    <dd>
                      {target.activeMemberAccessCount} active{' '}
                      {target.activeMemberAccessCount === 1 ? 'member' : 'members'}
                      {sharedWithOthers ? ' (shared)' : ''}
                      {!target.hasCurrentUserAccess ? ' · not available to you' : ''}
                    </dd>
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">Target ID</dt>
                    <dd className="break-all font-mono text-xs">{target.id}</dd>
                  </div>
                </dl>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
