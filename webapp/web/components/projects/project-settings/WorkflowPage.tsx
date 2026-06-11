import { Badge, STATUS_LABEL, statusClasses } from '@/components/ui.tsx';

import type { ProjectStatusDto } from '../../../../shared/contract.ts';

type WorkflowPageProps = {
  statuses: ProjectStatusDto[];
};

export function WorkflowPage({ statuses }: WorkflowPageProps) {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Workflow / statuses</h2>
        <p className="text-sm text-muted-foreground">
          Board columns for this project. Status types are fixed; names and order can be changed
          from the CLI for now.
        </p>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No statuses configured.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Default</th>
                <th className="px-3 py-2 font-medium">Order</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map(status => (
                <tr key={status.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{status.name}</td>
                  <td className="px-3 py-2">
                    <Badge className={statusClasses(status.type)}>
                      {STATUS_LABEL[status.type]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {status.isDefault
                      ? 'Default'
                      : status.type === 'execute' || status.type === 'review'
                        ? 'Exclusive'
                        : '—'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{status.position}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
