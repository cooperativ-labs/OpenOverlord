import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { Archive, FolderKanban, Inbox, Plus, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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
import { useProjects, useReorderProjects } from '@/lib/queries';

import type { ProjectDto } from '../../shared/contract.ts';

export function AppSidebar() {
  const projects = useProjects();
  const reorderProjects = useReorderProjects();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialNav, setSettingsInitialNav] = useState<SettingsNavSection | undefined>();
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const openSettings = (section?: SettingsNavSection) => {
    setSettingsInitialNav(section);
    setSettingsOpen(true);
  };

  const { activeProjects, archivedProjects } = useMemo(() => {
    const all = projects.data ?? [];
    return {
      activeProjects: [...all.filter(project => project.status === 'active')].sort(
        (a, b) => a.position - b.position
      ),
      archivedProjects: [...all.filter(project => project.status === 'archived')].sort(
        (a, b) => a.position - b.position
      )
    };
  }, [projects.data]);

  // Optimistic local order for the sidebar's active projects, kept in sync
  // with the server order and overridden immediately on drop (mirrors the
  // same pattern used for card statuses in StatusesPage).
  const [activeOrder, setActiveOrder] = useState<string[]>(() =>
    activeProjects.map(project => project.id)
  );

  useEffect(() => {
    const incomingIds = activeProjects.map(project => project.id);
    setActiveOrder(previous => {
      const previousSet = new Set(previous);
      const incomingSet = new Set(incomingIds);
      const sameMembership =
        previous.length === incomingIds.length && previous.every(id => incomingSet.has(id));
      if (sameMembership) return previous;
      const kept = previous.filter(id => incomingSet.has(id));
      const additions = incomingIds.filter(id => !previousSet.has(id));
      return [...kept, ...additions];
    });
  }, [activeProjects]);

  const orderedActiveProjects = useMemo(() => {
    const byId = new Map(activeProjects.map(project => [project.id, project]));
    return activeOrder
      .map(id => byId.get(id))
      .filter((project): project is ProjectDto => Boolean(project));
  }, [activeProjects, activeOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = activeOrder.indexOf(String(active.id));
    const newIndex = activeOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const nextOrder = arrayMove(activeOrder, oldIndex, newIndex);
    setActiveOrder(nextOrder);
    setReorderError(null);

    reorderProjects.mutate(
      { orderedProjectIds: [...nextOrder, ...archivedProjects.map(project => project.id)] },
      {
        onError: error => {
          setActiveOrder(activeProjects.map(project => project.id));
          setReorderError(error instanceof Error ? error.message : 'Failed to reorder projects.');
        }
      }
    );
  }

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
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={activeOrder} strategy={verticalListSortingStrategy}>
                    {orderedActiveProjects.map(project => (
                      <ProjectSidebarMenuItem
                        key={project.id}
                        project={project}
                        isActive={params.projectId === project.id}
                        onOpenSettings={setProjectSettingsId}
                        dragDisabled={reorderProjects.isPending}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
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
              {reorderError ? (
                <p className="px-2 pt-1 text-xs text-destructive">{reorderError}</p>
              ) : null}
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
