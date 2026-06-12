import { Link, useParams } from '@tanstack/react-router';
import { Archive, FolderKanban, LayoutGrid, Plus, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NavUser } from '@/components/nav-user';
import { ProjectCreatorModal } from '@/components/projects/ProjectCreatorModal';
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
import { useMeta, useProjects } from '@/lib/queries';
import { type LinkState, useRealtime } from '@/lib/realtime';

import type { ProjectDto } from '../../shared/contract.ts';

function RealtimeStatus({ sqlStudio }: { sqlStudio?: { enabled: boolean; url: string | null } }) {
  const { state } = useRealtime();
  const config: Record<LinkState, { label: string; dot: string }> = {
    live: { label: 'Live', dot: 'bg-emerald-400' },
    connecting: { label: 'Connecting…', dot: 'bg-amber-400' },
    reconnecting: { label: 'Reconnecting…', dot: 'bg-amber-400 animate-pulse' }
  };
  const c = config[state];
  const sqlStudioUrl = sqlStudio?.enabled ? sqlStudio.url : null;
  const canOpenSqlStudio = Boolean(sqlStudioUrl);

  const content = (
    <>
      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
      {c.label}
    </>
  );

  if (canOpenSqlStudio) {
    return (
      <button
        type="button"
        className="flex items-center gap-2 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
        title="Open SQL Studio"
        onClick={() => window.open(sqlStudioUrl ?? undefined, '_blank', 'noopener,noreferrer')}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">{content}</div>
  );
}

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
};

function ProjectMenuItem({ project, isActive }: ProjectMenuItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
        isActive={isActive}
        tooltip={project.name}
      >
        <ProjectColorDot color={project.color} />
        <span>{project.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const meta = useMeta();
  const projects = useProjects();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialNav, setSettingsInitialNav] = useState<SettingsNavSection | undefined>();

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

  const isProjectsActive = !params.projectId;

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <WorkspaceSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link to="/projects" />}
                    isActive={isProjectsActive}
                    tooltip="All projects"
                  >
                    <LayoutGrid />
                    <span>All projects</span>
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
          <RealtimeStatus sqlStudio={meta.data?.sqlStudio} />
          {meta.data?.databasePath && (
            <p
              className="truncate px-2 text-[10px] text-muted-foreground"
              title={meta.data.databasePath}
            >
              {meta.data.databasePath.split('/').slice(-2).join('/')}
            </p>
          )}
          <SidebarSeparator className="mx-0" />
          <NavUser onOpenSettings={openSettings} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <ProjectCreatorModal open={projectCreatorOpen} onOpenChange={setProjectCreatorOpen} />
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
