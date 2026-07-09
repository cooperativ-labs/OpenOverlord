'use client';

import { Badge } from '@/components/ui/badge';
import { missionDraftResourceBadgeKey, projectResourceLabel } from '@/lib/project-resources.ts';
import { useProjectResources } from '@/lib/queries.ts';
import { cn } from '@/lib/utils.ts';

export function MissionDraftResourceBadge({
  projectId,
  draftObjectiveResourceKey,
  className
}: {
  projectId: string;
  draftObjectiveResourceKey: string | null;
  className?: string;
}) {
  const resourcesQ = useProjectResources(projectId);
  const resources = resourcesQ.data ?? [];
  const resourceKey = missionDraftResourceBadgeKey({ resources, draftObjectiveResourceKey });
  if (!resourceKey) return null;

  const label = projectResourceLabel({ resources, resourceKey });

  return (
    <Badge
      className={cn(
        'pointer-events-none h-5 shrink-0 rounded-sm border-foreground/50 bg-muted/5 px-2 py-0 text-[10px] font-medium text-foreground',
        className
      )}
      title={`Draft objective resource: ${label}`}
    >
      {label}
    </Badge>
  );
}
