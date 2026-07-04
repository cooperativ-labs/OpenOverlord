import { Link, useRouterState } from '@tanstack/react-router';
import { Inbox, Settings } from 'lucide-react';
import { useState } from 'react';

import { NavUser } from '@/components/nav-user';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { SettingsModal, type SettingsNavSection } from '@/components/settings/SettingsModal.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator
} from '@/components/ui/sidebar';
import { WorkspaceSettingsModal } from '@/components/workspaces/WorkspaceSettingsModal';
import { WorkspaceSidebarSection } from '@/components/WorkspaceSidebarSection';
import { DRAG_REGION, getDesktopChrome, NO_DRAG_REGION } from '@/lib/desktop-chrome';
import { useMeta } from '@/lib/queries';

export function AppSidebar() {
  const meta = useMeta();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialNav, setSettingsInitialNav] = useState<SettingsNavSection | undefined>();
  const [workspaceSettingsId, setWorkspaceSettingsId] = useState<string | null>(null);

  const organizationId = meta.data?.organization?.id ?? null;
  const workspaces = meta.data?.workspaces ?? [];

  const openSettings = (section?: SettingsNavSection) => {
    setSettingsInitialNav(section);
    setSettingsOpen(true);
  };

  const pathname = useRouterState({ select: state => state.location.pathname });
  const isMyMissionsActive = pathname === '/workspace' || pathname.startsWith('/workspace/');
  const { isMacDesktop } = getDesktopChrome();

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader
          className={isMacDesktop ? 'pt-10' : undefined}
          style={isMacDesktop ? DRAG_REGION : undefined}
        >
          <div style={isMacDesktop ? NO_DRAG_REGION : undefined}>
            <OrganizationSwitcher />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Organization</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link to="/workspace" />}
                    isActive={isMyMissionsActive}
                    tooltip="My Missions"
                  >
                    <Inbox />
                    <span>My Missions</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {organizationId
            ? workspaces.map(workspace => (
                <WorkspaceSidebarSection
                  key={workspace.id}
                  workspace={workspace}
                  organizationId={organizationId}
                  onOpenWorkspaceSettings={setWorkspaceSettingsId}
                />
              ))
            : null}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => openSettings()} tooltip="Settings">
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>

          <SidebarSeparator className="mx-0" />
          <NavUser onOpenSettings={openSettings} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <WorkspaceSettingsModal
        open={workspaceSettingsId !== null}
        onOpenChange={nextOpen => {
          if (!nextOpen) setWorkspaceSettingsId(null);
        }}
        workspaceId={workspaceSettingsId}
      />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={nextOpen => {
          setSettingsOpen(nextOpen);
          if (!nextOpen) setSettingsInitialNav(undefined);
        }}
        initialNav={settingsInitialNav}
      />
    </>
  );
}
