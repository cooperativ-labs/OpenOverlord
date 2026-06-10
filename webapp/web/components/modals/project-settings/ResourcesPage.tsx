import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useProjectResources } from '@/lib/queries';

type ResourcesPageProps = {
  open: boolean;
  projectId: string;
};

function resourceStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Linked';
    case 'missing':
      return 'Missing';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

export function ResourcesPage({ open, projectId }: ResourcesPageProps) {
  const resources = useProjectResources(projectId);
  const rows = open ? (resources.data ?? []) : [];
  const hasMissingPrimary = rows.some(resource => resource.isPrimary && resource.status === 'missing');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Resource directories</h2>
        <p className="text-sm text-muted-foreground">
          Local paths linked to this project for runner launch and repository context.
        </p>
      </div>

      {hasMissingPrimary ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            The primary working directory is missing. Link a directory with{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">ovld add-cwd</code> before
            launching agents.
          </p>
        </div>
      ) : null}

      {resources.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading resources…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <p className="mb-2">No directories linked yet.</p>
          <p>
            From a checkout directory, run{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">ovld add-cwd</code> to link it
            to this project.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Primary</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(resource => (
                <tr key={resource.id} className="border-t">
                  <td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={resource.path}>
                    {resource.path}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{resource.type}</td>
                  <td className="px-3 py-2">
                    {resource.isPrimary ? (
                      <Badge variant="secondary">Primary</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={resource.status === 'missing' ? 'destructive' : 'secondary'}
                    >
                      {resourceStatusLabel(resource.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Directory linking from the browser requires a local backend with filesystem access. Use the
        CLI when the web app cannot see your machine.
      </p>
    </div>
  );
}
