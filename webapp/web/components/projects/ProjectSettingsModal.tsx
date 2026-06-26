import { FolderTree, Plug, Settings, Tag, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DangerZonePage } from '@/components/projects/project-settings/DangerZonePage.tsx';
import { GeneralPage } from '@/components/projects/project-settings/GeneralPage.tsx';
import { IntegrationsPage } from '@/components/projects/project-settings/IntegrationsPage.tsx';
import { ResourcesPage } from '@/components/projects/project-settings/ResourcesPage.tsx';
import { TagsPage } from '@/components/projects/project-settings/TagsPage.tsx';
import {
  SettingsDialogShell,
  type SettingsNavItem
} from '@/components/settings/SettingsDialogShell.tsx';

import type { ProjectDto } from '../../../shared/contract.ts';

const navItems: SettingsNavItem[] = [
  { name: 'General', icon: Settings },
  { name: 'Resources', icon: FolderTree },
  { name: 'Tags', icon: Tag },
  { name: 'Integrations', icon: Plug },
  { name: 'Danger zone', icon: Trash2 }
];

export type ProjectSettingsNavSection = (typeof navItems)[number]['name'];

type ProjectSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectDto;
  initialNav?: ProjectSettingsNavSection;
};

export function ProjectSettingsModal({
  open,
  onOpenChange,
  project,
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
        <GeneralPage
          open={open}
          project={project}
          onOpenChange={onOpenChange}
          onNavigateToIntegrations={() => setActiveNav('Integrations')}
        />
      )}
      {activeNav === 'Resources' && <ResourcesPage open={open} projectId={project.id} />}
      {activeNav === 'Tags' && <TagsPage projectId={project.id} />}
      {activeNav === 'Integrations' && <IntegrationsPage open={open} project={project} />}
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
