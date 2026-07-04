import { Archive, GitBranch, Settings, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  SettingsDialogShell,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell.tsx';
import { StatusesPage } from '@/components/settings/StatusesPage';
import { ArchivedProjectsPage } from '@/components/workspaces/workspace-settings/ArchivedProjectsPage.tsx';
import { DangerZonePage } from '@/components/workspaces/workspace-settings/DangerZonePage.tsx';
import { GeneralPage } from '@/components/workspaces/workspace-settings/GeneralPage.tsx';
import { MembersPage } from '@/components/workspaces/workspace-settings/MembersPage.tsx';
import { useMeta } from '@/lib/queries';

const navItems: SettingsNavItem[] = [
  { name: 'General', icon: Settings },
  { name: 'Members', icon: Users },
  { name: 'Card statuses', icon: GitBranch },
  { name: 'Archived projects', icon: Archive },
  { name: 'Danger zone', icon: Trash2 }
];

export type WorkspaceSettingsNavSection = (typeof navItems)[number]['name'];

type WorkspaceSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  initialNav?: WorkspaceSettingsNavSection;
};

/**
 * The workspace-level settings modal (the organization settings surface in the
 * hosted product). Reads the workspace from the already-cached workspace list
 * rather than a dedicated detail endpoint.
 */
export function WorkspaceSettingsModal({
  open,
  onOpenChange,
  workspaceId,
  initialNav
}: WorkspaceSettingsModalProps) {
  const meta = useMeta();
  const [activeNav, setActiveNav] = useState<WorkspaceSettingsNavSection>('General');

  useEffect(() => {
    if (!open) return;

    if (initialNav && navItems.some(item => item.name === initialNav)) {
      setActiveNav(initialNav);
      return;
    }

    setActiveNav('General');
  }, [open, initialNav]);

  const workspace = (meta.data?.workspaces ?? []).find(w => w.id === workspaceId) ?? null;
  const isOnlyWorkspace = (meta.data?.workspaces ?? []).length <= 1;

  return (
    <SettingsDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Workspace settings"
      description="Customize your workspace settings here."
      breadcrumbRoot={workspace?.name ?? 'Workspace settings'}
      navGroups={[{ items: navItems }]}
      activeNav={activeNav}
      onActiveNavChange={name => setActiveNav(name as WorkspaceSettingsNavSection)}
    >
      {meta.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : meta.isError ? (
        <p className="text-sm text-destructive">
          {meta.error instanceof Error ? meta.error.message : 'Failed to load workspace.'}
        </p>
      ) : !workspace ? (
        <p className="text-xs text-muted-foreground">Workspace not found.</p>
      ) : (
        <>
          {activeNav === 'General' && <GeneralPage open={open} workspace={workspace} />}
          {activeNav === 'Members' && <MembersPage workspaceId={workspace.id} />}
          {activeNav === 'Card statuses' && <StatusesPage />}
          {activeNav === 'Archived projects' &&
            // `/api/projects` is scoped to the active workspace, so archived
            // projects can only be managed for the workspace you are in.
            (workspace.isActive ? (
              <ArchivedProjectsPage />
            ) : (
              <p className="text-xs text-muted-foreground">
                Switch to this workspace to manage its archived projects.
              </p>
            ))}
          {activeNav === 'Danger zone' && (
            <DangerZonePage
              workspace={workspace}
              isOnlyWorkspace={isOnlyWorkspace}
              onOpenChange={onOpenChange}
            />
          )}
        </>
      )}
    </SettingsDialogShell>
  );
}
