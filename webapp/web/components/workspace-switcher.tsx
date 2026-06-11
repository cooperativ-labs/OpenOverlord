import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Globe, Plus } from 'lucide-react';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
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
import { useActivateWorkspace, useMeta, useWorkspaces } from '@/lib/queries';

import type { WorkspaceDto } from '../../shared/contract.ts';

function WorkspaceGlyph({ workspace }: { workspace: WorkspaceDto | null }) {
  const initial = workspace?.name.trim().charAt(0).toUpperCase();
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

  const items = workspaces.data ?? [];
  const active =
    items.find(w => w.isActive) ??
    (meta.data
      ? {
          id: meta.data.workspace.id,
          slug: meta.data.workspace.slug,
          name: meta.data.workspace.name,
          kind: 'local',
          isActive: true,
          projectCount: 0,
          memberCount: 0,
          createdAt: ''
        }
      : null);

  function handleSelect(workspace: WorkspaceDto) {
    if (workspace.isActive) return;
    activateWorkspace.mutate(workspace.id, {
      // Land on the projects list — project routes from the old workspace no
      // longer resolve under the newly active one.
      onSuccess: () => void navigate({ to: '/projects' })
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
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 p-2" onClick={() => setCreateOpen(true)}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                  <Plus className="size-4" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">Create workspace</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <WorkspaceCreatorModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
