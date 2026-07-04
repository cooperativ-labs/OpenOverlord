import { Check, ChevronsUpDown, Globe, Plus, Settings } from 'lucide-react';
import { useState } from 'react';

import { OrganizationCreatorModal } from '@/components/organizations/OrganizationCreatorModal';
import { OrganizationSettingsModal } from '@/components/organizations/OrganizationSettingsModal';
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
import { useOrganizationAdminStatus } from '@/lib/hooks/use-organization-admin-status';
import { useActivateOrganization, useMeta, useOrganizations } from '@/lib/queries';
import { useAuthenticatedMediaUrl } from '@/lib/use-authenticated-media-url.ts';

import type { OrganizationDto } from '../../shared/contract.ts';

function OrganizationGlyph({ organization }: { organization: OrganizationDto | null }) {
  const initial = organization?.name.trim().charAt(0).toUpperCase();
  const logoUrl = useAuthenticatedMediaUrl(organization?.logoUrl);

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

export function OrganizationSwitcher() {
  const { isMobile } = useSidebar();
  const meta = useMeta();
  const organizations = useOrganizations();
  const activateOrganization = useActivateOrganization();
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const items = organizations.data ?? meta.data?.organizations ?? [];
  const active = items.find(org => org.isActive) ?? meta.data?.organization ?? items[0] ?? null;
  const workspaces = meta.data?.workspaces ?? [];
  const adminStatus = useOrganizationAdminStatus({
    organizationId: active?.id ?? null,
    workspaces
  });

  function handleSelect(organization: OrganizationDto) {
    if (organization.isActive) return;
    activateOrganization.mutate(organization.id);
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
              <OrganizationGlyph organization={active} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active?.name ?? 'Organization'}</span>
                <span className="truncate text-xs text-muted-foreground">Organization</span>
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
                  Organizations
                </DropdownMenuLabel>
                {items.map(organization => (
                  <DropdownMenuItem
                    key={organization.id}
                    className="gap-2 p-2"
                    onClick={() => handleSelect(organization)}
                  >
                    <OrganizationGlyph organization={organization} />
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-medium">{organization.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {organization.workspaceCount}{' '}
                        {organization.workspaceCount === 1 ? 'workspace' : 'workspaces'}
                      </span>
                    </div>
                    {organization.isActive ? <Check className="ml-auto size-4" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {adminStatus.canView ? (
                  <DropdownMenuItem className="gap-2 p-2" onClick={() => setSettingsOpen(true)}>
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                      <Settings className="size-4" />
                    </div>
                    <span className="text-sm font-medium text-muted-foreground">
                      Organization settings
                    </span>
                  </DropdownMenuItem>
                ) : null}
                {adminStatus.isOrgAdmin ? (
                  <DropdownMenuItem
                    className="gap-2 p-2"
                    onClick={() => setCreateWorkspaceOpen(true)}
                  >
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                      <Plus className="size-4" />
                    </div>
                    <span className="text-sm font-medium text-muted-foreground">
                      Create workspace
                    </span>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="gap-2 p-2" onClick={() => setCreateOrgOpen(true)}>
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background">
                    <Plus className="size-4" />
                  </div>
                  <span className="text-sm font-medium text-muted-foreground">
                    Create organization
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <OrganizationCreatorModal open={createOrgOpen} onOpenChange={setCreateOrgOpen} />
      <WorkspaceCreatorModal open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      <OrganizationSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        organizationId={active?.id ?? null}
      />
    </>
  );
}
