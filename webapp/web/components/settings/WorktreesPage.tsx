import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLaunchSettings, useUpdateWorktreeBranchAutomation } from '@/lib/queries';

export function WorktreesPage() {
  const launchSettings = useLaunchSettings();
  const updateWorktrees = useUpdateWorktreeBranchAutomation();
  const worktreesEnabled = launchSettings.data?.worktreeBranchAutomationEnabled ?? true;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Worktrees</h2>
        <p className="text-sm text-muted-foreground">
          Control how Overlord isolates ticket work in branches and worktrees.
        </p>
      </div>

      <div className="max-w-md space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="worktree-branch-automation">Ticket worktrees</Label>
            <p className="text-xs text-muted-foreground">
              Launch each ticket in its own branch and worktree under the Overlord home folder.
            </p>
          </div>
          <Switch
            id="worktree-branch-automation"
            checked={worktreesEnabled}
            disabled={launchSettings.isLoading || updateWorktrees.isPending}
            onCheckedChange={enabled => updateWorktrees.mutate({ enabled })}
          />
        </div>
        {updateWorktrees.isError && (
          <p className="text-xs text-red-400">{(updateWorktrees.error as Error).message}</p>
        )}
      </div>
    </div>
  );
}
