import { FolderTree, GitBranch, Settings, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DangerZonePage } from '@/components/projects/project-settings/DangerZonePage.tsx';
import { GeneralPage } from '@/components/projects/project-settings/GeneralPage.tsx';
import { ResourcesPage } from '@/components/projects/project-settings/ResourcesPage.tsx';
import { WorkflowPage } from '@/components/projects/project-settings/WorkflowPage.tsx';
import {
  SettingsDialogShell,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell.tsx';

import type { ProjectDto, ProjectStatusDto } from '../../../shared/contract.ts';

const navItems: SettingsNavItem[] = [
  { name: 'General', icon: Settings },
  { name: 'Resources', icon: FolderTree },
  { name: 'Workflow', icon: GitBranch },
  { name: 'Danger zone', icon: Trash2 }
];

export type ProjectSettingsNavSection = (typeof navItems)[number]['name'];

type ProjectSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectDto;
  statuses: ProjectStatusDto[];
  initialNav?: ProjectSettingsNavSection;
};

export function ProjectSettingsModal({
  open,
  onOpenChange,
  project,
  statuses,
  initialNav
}: ProjectSettingsModalProps) {
  const [activeNav, setActiveNav] = useState<ProjectSettingsNavSection>('General');

  useEffect(() => {
    if (!open) return;

    if (initialNav && navItems.some(item => item.name === initialNav)) {
      setActiveNav(initialNav);
      return;
    }

    setActiveNav('General');
  }, [open, initialNav]);

  return (
    <SettingsDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Project settings"
      description="Customize your project settings here."
      breadcrumbRoot="Project settings"
      navGroups={[{ items: navItems }]}
      activeNav={activeNav}
      onActiveNavChange={name => setActiveNav(name as ProjectSettingsNavSection)}
    >
      {activeNav === 'General' && (
        <GeneralPage open={open} project={project} onOpenChange={onOpenChange} />
      )}
      {activeNav === 'Resources' && <ResourcesPage open={open} projectId={project.id} />}
      {activeNav === 'Workflow' && <WorkflowPage projectId={project.id} statuses={statuses} />}
      {activeNav === 'Danger zone' && (
        <DangerZonePage
          projectId={project.id}
          projectName={project.name}
          isArchived={project.status === 'archived'}
          onOpenChange={onOpenChange}
        />
      )}
    </SettingsDialogShell>
  );
}
