import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, Settings } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { SidebarLinkMenuButton } from '@/components/sidebar-link-menu-button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { useUpdateProject } from '@/lib/queries';

import type { ProjectDto } from '../../shared/contract.ts';

function ProjectColorDot({ color }: { color: string | null }) {
  if (!color) return null;
  return (
    <span
      className="size-2 shrink-0 rounded-full ring-1 ring-sidebar-border group-data-[collapsible=icon]:size-3.5"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

type ProjectSidebarMenuItemProps = {
  project: ProjectDto;
  isActive: boolean;
  onOpenSettings: (projectId: string) => void;
};

export function ProjectSidebarMenuItem({
  project,
  isActive,
  onOpenSettings
}: ProjectSidebarMenuItemProps) {
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
      buttonClassName="group-data-[collapsible=icon]:flex-col items-center font-medium group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:pb-0"
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
      <span className="group-data-[collapsible=icon]:hidden">{project.name}</span>
    </SidebarLinkMenuButton>
  );
}
