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
import { useParams } from '@tanstack/react-router';
import { ChevronDown, Plus, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ProjectCreatorModal } from '@/components/projects/ProjectCreatorModal';
import { ProjectSettingsModal } from '@/components/projects/ProjectSettingsModal';
import { ProjectSidebarMenuItem } from '@/components/ProjectSidebarMenuItem';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isWorkspaceSectionExpanded, setWorkspaceSectionExpanded } from '@/lib/org-preferences';
import { useProjects, useReorderProjects } from '@/lib/queries';

import type { ProjectDto, WorkspaceDto } from '../../shared/contract.ts';

type WorkspaceSidebarSectionProps = {
  workspace: WorkspaceDto;
  organizationId: string;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
};

export function WorkspaceSidebarSection({
  workspace,
  organizationId,
  onOpenWorkspaceSettings
}: WorkspaceSidebarSectionProps) {
  const projects = useProjects(workspace.id, 'all');
  const reorderProjects = useReorderProjects(workspace.id);
  const params = useParams({ strict: false }) as { projectId?: string };
  const [expanded, setExpanded] = useState(() =>
    isWorkspaceSectionExpanded({ organizationId, workspaceId: workspace.id })
  );
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

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

  function handleExpandedChange(nextExpanded: boolean) {
    setExpanded(nextExpanded);
    setWorkspaceSectionExpanded({
      organizationId,
      workspaceId: workspace.id,
      expanded: nextExpanded
    });
  }

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

  return (
    <>
      <SidebarGroup>
        <Collapsible open={expanded} onOpenChange={handleExpandedChange}>
          <div className="flex items-center justify-between gap-1 px-2">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 text-left">
              <ChevronDown
                className={`size-4 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
              />
              <SidebarGroupLabel className="truncate p-0">{workspace.name}</SidebarGroupLabel>
            </CollapsibleTrigger>
            <div className="flex shrink-0 items-center justify-end gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      onClick={() => onOpenWorkspaceSettings(workspace.id)}
                    >
                      <Settings className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent side="top">Workspace settings</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      onClick={() => setProjectCreatorOpen(true)}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipContent side="top">Add project</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <CollapsibleContent>
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
              </SidebarMenu>
              {reorderError ? (
                <p className="px-2 pt-1 text-xs text-destructive">{reorderError}</p>
              ) : null}
            </SidebarGroupContent>
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroup>

      <ProjectCreatorModal
        open={projectCreatorOpen}
        onOpenChange={setProjectCreatorOpen}
        workspaceId={workspace.id}
      />
      {projectForSettings ? (
        <ProjectSettingsModal
          open={projectSettingsId !== null}
          onOpenChange={nextOpen => {
            if (!nextOpen) setProjectSettingsId(null);
          }}
          project={projectForSettings}
        />
      ) : null}
    </>
  );
}
