import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ProjectCreatorModal } from '@/components/projects/ProjectCreatorModal';

import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui.tsx';
import { useProjects } from '../lib/queries.ts';

export function ProjectsPage() {
  const projects = useProjects();
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className=" min-h-0 flex-1 overflow-y-auto  px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-[var(--color-ink-dim)]">
            Everything in this workspace, live from the database.
          </p>
        </div>
        <Button variant="primary" onClick={() => setModalOpen(true)}>
          + New project
        </Button>
      </header>

      {projects.isLoading && <Spinner />}
      {projects.isError && (
        <p className="text-sm text-red-400">
          Could not load projects: {(projects.error as Error).message}
        </p>
      )}

      {projects.data && projects.data.length === 0 && (
        <EmptyState
          title="No projects yet"
          hint="Create your first project to start adding tickets and objectives. The CLI can create them too — they'll appear here instantly."
          action={
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              + New project
            </Button>
          }
        />
      )}

      {projects.data && projects.data.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.map(p => (
            <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }}>
              <Card className="h-full p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {p.color && (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-border/60"
                        style={{ backgroundColor: p.color }}
                        aria-hidden
                      />
                    )}
                    <h2 className="truncate font-medium">{p.name}</h2>
                  </div>
                  {p.status === 'archived' && (
                    <Badge className="bg-zinc-500/15 text-zinc-400 ring-zinc-400/30">
                      Archived
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-2 min-h-[2.5rem] text-sm text-[var(--color-ink-dim)]">
                  {p.description || 'No description'}
                </p>
                <div className="mt-3 text-xs text-[var(--color-ink-dim)]">
                  {p.ticketCount} ticket{p.ticketCount === 1 ? '' : 's'}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <ProjectCreatorModal open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
