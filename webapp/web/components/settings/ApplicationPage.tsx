import { useTheme } from 'next-themes';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLaunchSettings, useUpdateWorktreeBranchAutomation } from '@/lib/queries';

const themeOptions = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
] as const;

export function ApplicationPage() {
  const { theme, setTheme } = useTheme();
  const launchSettings = useLaunchSettings();
  const updateWorktrees = useUpdateWorktreeBranchAutomation();
  const worktreesEnabled = launchSettings.data?.worktreeBranchAutomationEnabled ?? true;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Application</h2>
        <p className="text-sm text-muted-foreground">
          Appearance preferences for this browser session.
        </p>
      </div>

      <div className="max-w-md space-y-2">
        <Label htmlFor="theme-select">Theme</Label>
        <Select
          value={theme ?? 'system'}
          onValueChange={value => {
            if (value) setTheme(value);
          }}
        >
          <SelectTrigger id="theme-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {themeOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          System follows your OS appearance setting. Stored locally in this browser.
        </p>
      </div>

      <div className="max-w-md space-y-3 border-t border-border pt-5">
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
