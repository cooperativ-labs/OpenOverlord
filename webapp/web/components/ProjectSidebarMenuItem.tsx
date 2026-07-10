import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, Clock3, Settings } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { SidebarLinkMenuButton } from '@/components/sidebar-link-menu-button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { useEverhourIntegration, useProjectEverhour, useUpdateProject } from '@/lib/queries';

import type { ProjectDto } from '../../shared/contract.ts';

function ProjectColorDot({ color }: { color: string | null }) {
  if (!color) return null;
  return (
    <span
      className="size-2 shrink-0 rounded-full ring-1 ring-sidebar-border transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-data-[collapsible=icon]:size-3.5 group-data-[collapsible=icon]:opacity-100"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

type ProjectSidebarMenuItemProps = {
  project: ProjectDto;
  isActive: boolean;
  onOpenSettings: (projectId: string) => void;
  /** Disable drag reordering, e.g. while a reorder mutation is in flight. */
  dragDisabled?: boolean;
};

export function ProjectSidebarMenuItem({
  project,
  isActive,
  onOpenSettings,
  dragDisabled = false
}: ProjectSidebarMenuItemProps) {
  const updateProject = useUpdateProject(project.id);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [menuOpen, setMenuOpen] = useState(false);
  const savedColor = project.color ?? DEFAULT_PROJECT_COLOR;
  const integration = useEverhourIntegration();
  const everhourConnected = integration.data?.connected ?? false;
  const projectEverhour = useProjectEverhour(project.id, { enabled: everhourConnected });
  const hasRunningTimer = Boolean(projectEverhour.data?.hasRunningTimerInProject);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: project.id, disabled: dragDisabled });

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
        void navigate({ to: '/user' });
      }
    } catch {
      // Error handled by mutation
    }
  }

  return (
    <SidebarLinkMenuButton
      isActive={isActive}
      tooltip={project.name}
      buttonClassName="items-center text-foreground/80 font-medium group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:pb-0"
      link={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
      menuLabel="Project options"
      dragHandleSide="left"
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      menuDisabled={updateProject.isPending}
      itemRef={setNodeRef}
      itemStyle={{ transform: CSS.Transform.toString(transform), transition }}
      isDragging={isDragging}
      dragHandle={{
        ref: setActivatorNodeRef,
        attributes,
        listeners,
        label: `Reorder ${project.name}`,
        disabled: dragDisabled
      }}
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
      <span className="inline-flex min-w-0 items-center gap-1.5 group-data-[collapsible=icon]:hidden">
        <span className="truncate">{project.name}</span>
        {hasRunningTimer ? (
          <Clock3
            className="h-4 w-4 text-red-700"
            size={12}
            aria-label="Running Everhour timer in this project"
          />
        ) : null}
      </span>
    </SidebarLinkMenuButton>
  );
}
