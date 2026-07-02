import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { Archive, FolderKanban, Inbox, Plus, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NavUser } from '@/components/nav-user';
import { ProjectCreatorModal } from '@/components/projects/ProjectCreatorModal';
import { ProjectSettingsModal } from '@/components/projects/ProjectSettingsModal';
import { ProjectSidebarMenuItem } from '@/components/ProjectSidebarMenuItem';
import { SettingsModal, type SettingsNavSection } from '@/components/settings/SettingsModal.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator
} from '@/components/ui/sidebar';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { DRAG_REGION, getDesktopChrome, NO_DRAG_REGION } from '@/lib/desktop-chrome';
import { useProjects } from '@/lib/queries';

export function AppSidebar() {
  const projects = useProjects();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialNav, setSettingsInitialNav] = useState<SettingsNavSection | undefined>();
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);

  const openSettings = (section?: SettingsNavSection) => {
    setSettingsInitialNav(section);
    setSettingsOpen(true);
  };

  const { activeProjects, archivedProjects } = useMemo(() => {
    const all = projects.data ?? [];
    return {
      activeProjects: all.filter(project => project.status === 'active'),
      archivedProjects: all.filter(project => project.status === 'archived')
    };
  }, [projects.data]);

  const projectForSettings = useMemo(
    () => (projectSettingsId ? (projects.data ?? []).find(p => p.id === projectSettingsId) : null),
    [projectSettingsId, projects.data]
  );

  const pathname = useRouterState({ select: state => state.location.pathname });
  const isMyMissionsActive = pathname === '/workspace' || pathname.startsWith('/workspace/');

  // On macOS the shell insets the traffic lights at (14, 14), which sit over the
  // top-left of the sidebar. Reserve vertical room for them and make the cleared
  // strip a window-drag region (the WorkspaceSwitcher opts back out below).
  const { isMacDesktop } = getDesktopChrome();

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader
          className={isMacDesktop ? 'pt-10' : undefined}
          style={isMacDesktop ? DRAG_REGION : undefined}
        >
          <div style={isMacDesktop ? NO_DRAG_REGION : undefined}>
            <WorkspaceSwitcher />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
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

          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupAction title="New project" onClick={() => setProjectCreatorOpen(true)}>
              <Plus />
              <span className="sr-only">New project</span>
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {activeProjects.map(project => (
                  <ProjectSidebarMenuItem
                    key={project.id}
                    project={project}
                    isActive={params.projectId === project.id}
                    onOpenSettings={setProjectSettingsId}
                  />
                ))}
                {activeProjects.length === 0 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="text-muted-foreground"
                      onClick={() => setProjectCreatorOpen(true)}
                    >
                      <FolderKanban />
                      <span>Create a project</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {archivedProjects.length > 0 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={<Link to="/projects" />}
                      tooltip={`${archivedProjects.length} archived`}
                    >
                      <Archive />
                      <span>{archivedProjects.length} archived</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
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

          <SidebarSeparator className="mx-8" />
          <NavUser onOpenSettings={openSettings} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <ProjectCreatorModal open={projectCreatorOpen} onOpenChange={setProjectCreatorOpen} />
      {projectForSettings ? (
        <ProjectSettingsModal
          open={projectSettingsId !== null}
          onOpenChange={nextOpen => {
            if (!nextOpen) setProjectSettingsId(null);
          }}
          project={projectForSettings}
        />
      ) : null}
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
