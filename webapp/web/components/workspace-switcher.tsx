import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Globe, Plus, Settings } from 'lucide-react';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar';
import { WorkspaceCreatorModal } from '@/components/workspaces/WorkspaceCreatorModal';
import { WorkspaceSettingsModal } from '@/components/workspaces/WorkspaceSettingsModal';
import { useActivateWorkspace, useMeta, useWorkspaces } from '@/lib/queries';
import { useAuthenticatedMediaUrl } from '@/lib/use-authenticated-media-url.ts';

import type { WorkspaceDto } from '../../shared/contract.ts';

function WorkspaceGlyph({ workspace }: { workspace: WorkspaceDto | null }) {
  const initial = workspace?.name.trim().charAt(0).toUpperCase();
  const logoUrl = useAuthenticatedMediaUrl(workspace?.logoUrl);

  if (logoUrl) {
    return (
      <div className="flex aspect-square size-8 items-center justify-center overflow-hidden rounded-lg bg-muted">
        <img src={logoUrl} alt="" className="size-full object-cover" />
      </div>
    );
  }

  return (
    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
      {initial ? (
        <span className="text-sm font-medium">{initial}</span>
      ) : (
        <Globe className="size-4" />
      )}
    </div>
  );
}

export function WorkspaceSwitcher() {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const meta = useMeta();
  const workspaces = useWorkspaces();
  const activateWorkspace = useActivateWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const items = workspaces.data ?? [];
  const active =
    items.find(w => w.isActive) ??
    (meta.data?.workspace
      ? {
          id: meta.data.workspace.id,
          slug: meta.data.workspace.slug,
          name: meta.data.workspace.name,
          kind: 'local',
          isActive: true,
          projectCount: 0,
          memberCount: 0,
          sqlStudioEnabled: false,
          logoUrl: null,
          createdAt: ''
        }
      : null);

  function handleSelect(workspace: WorkspaceDto) {
    if (workspace.isActive) return;
    activateWorkspace.mutate(workspace.id, {
      // Land on My Missions for the newly active workspace. `/workspace` carries
      // no workspace-specific ids, so it always resolves after a switch (unlike
      // the old project routes, which no longer resolve under the new workspace).
      onSuccess: () => void navigate({ to: '/workspace' })
    });
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                />
              }
            >
              <WorkspaceGlyph workspace={active} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active?.name ?? 'Workspace'}</span>
                <span className="truncate text-xs text-muted-foreground">Workspace</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-60 rounded-lg"
              side={isMobile ? 'bottom' : 'right'}
              align="start"
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Workspaces
                </DropdownMenuLabel>
                {items.map(workspace => (
                  <DropdownMenuItem
                    key={workspace.id}
                    className="gap-2 p-2"
                    onClick={() => handleSelect(workspace)}
                  >
                    <WorkspaceGlyph workspace={workspace} />
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-medium">{workspace.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {workspace.projectCount}{' '}
                        {workspace.projectCount === 1 ? 'project' : 'projects'}
                      </span>
                    </div>
                    {workspace.isActive && <Check className="ml-auto size-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem className="gap-2 p-2" onClick={() => setSettingsOpen(true)}>
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                    <Settings className="size-4" />
                  </div>
                  <span className="text-sm font-medium text-muted-foreground">
                    Workspace settings
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 p-2" onClick={() => setCreateOpen(true)}>
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                    <Plus className="size-4" />
                  </div>
                  <span className="text-sm font-medium text-muted-foreground">
                    Create workspace
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <WorkspaceCreatorModal open={createOpen} onOpenChange={setCreateOpen} />
      <WorkspaceSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workspaceId={active?.id ?? null}
      />
    </>
  );
}
