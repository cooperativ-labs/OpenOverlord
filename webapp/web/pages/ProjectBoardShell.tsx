import { Outlet, useParams } from '@tanstack/react-router';

import { ProjectRepositoryProvider } from '../components/projects/ProjectRepositoryContext.tsx';
import { ProjectSettingsProvider } from '../components/projects/ProjectSettingsContext.tsx';

import { BoardPage } from './BoardPage.tsx';

export function ProjectBoardShell() {
  const { projectId } = useParams({ from: '/projects/$projectId' });

  return (
    <ProjectRepositoryProvider projectId={projectId}>
      <ProjectSettingsProvider projectId={projectId}>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <BoardPage />
          </main>
          <Outlet />
        </div>
      </ProjectSettingsProvider>
    </ProjectRepositoryProvider>
  );
}
