import { Archive, Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useProjects, useUnarchiveProject } from '@/lib/queries';

type ArchivedProjectsPageProps = {
  /** The workspace whose archive is being managed — not necessarily the active one (coo:324). */
  workspaceId: string;
};

export function ArchivedProjectsPage({ workspaceId }: ArchivedProjectsPageProps) {
  const projects = useProjects(workspaceId, 'archived');
  const unarchiveProject = useUnarchiveProject();
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const archivedProjects = projects.data ?? [];

  async function handleUnarchive(projectId: string) {
    setUnarchivingId(projectId);
    setError(null);
    try {
      await unarchiveProject.mutateAsync(projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unarchive project.');
    } finally {
      setUnarchivingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Archived projects</h2>
        <p className="text-sm text-muted-foreground">
          Projects that have been archived. Unarchive a project to restore it to the sidebar and
          project selectors.
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {projects.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </div>
      ) : null}

      {!projects.isLoading && archivedProjects.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Project</th>
                <th className="px-3 py-2 text-left font-medium">Missions</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {archivedProjects.map(project => (
                <tr key={project.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {project.color ? (
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: project.color }}
                        />
                      ) : null}
                      <span className="text-sm">{project.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {project.missionCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={unarchivingId !== null}
                      onClick={() => void handleUnarchive(project.id)}
                    >
                      {unarchivingId === project.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3" />
                      )}
                      Unarchive
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!projects.isLoading && archivedProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
          <Archive className="size-8 opacity-40" />
          <p className="text-sm">No archived projects</p>
        </div>
      ) : null}
    </div>
  );
}
