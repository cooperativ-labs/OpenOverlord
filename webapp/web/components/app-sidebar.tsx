import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { Archive, FolderKanban, Inbox, Plus, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NavUser } from '@/components/nav-user';
import { ProjectCreatorModal } from '@/components/projects/ProjectCreatorModal';
import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { ProjectSettingsModal } from '@/components/projects/ProjectSettingsModal';
import { SettingsModal, type SettingsNavSection } from '@/components/settings/SettingsModal.tsx';
import { SidebarLinkMenuButton } from '@/components/sidebar-link-menu-button';
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
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { DRAG_REGION, getDesktopChrome, NO_DRAG_REGION } from '@/lib/desktop-chrome';
import { useProjects, useUpdateProject } from '@/lib/queries';

import type { ProjectDto } from '../../shared/contract.ts';

function ProjectColorDot({ color }: { color: string | null }) {
  if (!color) return null;
  return (
    <span
      className="size-2 shrink-0 rounded-full ring-1 ring-sidebar-border"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

type ProjectMenuItemProps = {
  project: ProjectDto;
  isActive: boolean;
  onOpenSettings: (projectId: string) => void;
};

function ProjectMenuItem({ project, isActive, onOpenSettings }: ProjectMenuItemProps) {
  const updateProject = useUpdateProject(project.id);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [menuOpen, setMenuOpen] = useState(false);
  const savedColor = project.color ?? DEFAULT_PROJECT_COLOR;

  async function handleChangeColor(nextColor: string) {
    if (nextColor.toLowerCase() === savedColor.toLowerCase() || updateProject.isPending) {
      return;
    }

    try {
      await updateProject.mutateAsync({ color: nextColor.toLowerCase() });
      setMenuOpen(false);
    } catch {
      // Mutation rollback restores the previous color; keep the menu open for another attempt.
    }
  }

  async function handleArchive() {
    setMenuOpen(false);
    try {
      await updateProject.mutateAsync({ status: 'archived' });
      if (params.projectId === project.id) {
        void navigate({ to: '/workspace' });
      }
    } catch {
      // Error handled by mutation
    }
  }

  return (
    <SidebarLinkMenuButton
      isActive={isActive}
      tooltip={project.name}
      link={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
      menuLabel="Project options"
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      menuDisabled={updateProject.isPending}
      menuContent={
        <>
          <div className="p-1">
            <ProjectColorSetter value={savedColor} onSelect={handleChangeColor} />
          </div>
          <DropdownMenuSeparator className="my-1" />
          <div className="p-1">
            <DropdownMenuItem
              className="p-1 text-xs"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings(project.id);
              }}
            >
              <Settings size={16} />
              <span>Project settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="p-1 text-xs"
              disabled={updateProject.isPending}
              onClick={() => void handleArchive()}
            >
              <Archive size={16} />
              <span>Archive project</span>
            </DropdownMenuItem>
          </div>
        </>
      }
    >
      <ProjectColorDot color={project.color} />
      <span>{project.name}</span>
    </SidebarLinkMenuButton>
  );
}

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
              <SidebarMenu>
                {activeProjects.map(project => (
                  <ProjectMenuItem
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

          <SidebarSeparator className="mx-0" />
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
