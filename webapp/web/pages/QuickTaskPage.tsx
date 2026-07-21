import { useEffect } from 'react';

import { QuickTaskBar } from '@/components/quick-task-bar/QuickTaskBar.tsx';
import { useAllProjects, useDefaultProject } from '@/lib/queries.ts';

function QuickTaskChrome() {
  useEffect(() => {
    if (window.overlord?.isDesktop !== true) return;
    document.documentElement.dataset.electron = 'true';
    document.documentElement.dataset.quickTask = 'true';
    return () => {
      delete document.documentElement.dataset.electron;
      delete document.documentElement.dataset.quickTask;
    };
  }, []);

  return null;
}

export function QuickTaskPage() {
  const projectsQ = useAllProjects();
  const defaultProjectQ = useDefaultProject();

  if (projectsQ.isLoading) {
    return (
      <>
        <QuickTaskChrome />
        <div className="p-4 text-sm text-muted-foreground">Loading…</div>
      </>
    );
  }

  return (
    <>
      <QuickTaskChrome />
      <QuickTaskBar defaultProjectId={defaultProjectQ.data?.projectId ?? null} />
    </>
  );
}
