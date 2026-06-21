import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import type { ProjectSettingsNavSection } from '@/components/projects/ProjectSettingsModal';
import { ProjectSettingsModal } from '@/components/projects/ProjectSettingsModal';
import { useProject } from '@/lib/queries';

type ProjectSettingsContextValue = {
  openProjectSettings: (nav?: ProjectSettingsNavSection) => void;
};

const ProjectSettingsContext = createContext<ProjectSettingsContextValue | null>(null);

export function ProjectSettingsProvider({
  projectId,
  children
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [initialNav, setInitialNav] = useState<ProjectSettingsNavSection | undefined>();
  const project = useProject(projectId);

  const value = useMemo<ProjectSettingsContextValue>(
    () => ({
      openProjectSettings: nav => {
        setInitialNav(nav);
        setOpen(true);
      }
    }),
    []
  );

  return (
    <ProjectSettingsContext.Provider value={value}>
      {children}
      {project.data ? (
        <ProjectSettingsModal
          open={open}
          onOpenChange={nextOpen => {
            setOpen(nextOpen);
            if (!nextOpen) setInitialNav(undefined);
          }}
          project={project.data}
          initialNav={initialNav}
        />
      ) : null}
    </ProjectSettingsContext.Provider>
  );
}

export function useProjectSettings(): ProjectSettingsContextValue | null {
  return useContext(ProjectSettingsContext);
}
