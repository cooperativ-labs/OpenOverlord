'use client';

import { Badge } from '@/components/ui/badge';
import { useProjectResources } from '@/lib/queries.ts';
import {
  missionDraftResourceBadgeKey,
  projectResourceLabel
} from '@/lib/project-resources.ts';
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
      variant="secondary"
      className={cn(
        'pointer-events-none h-4 shrink-0 rounded-full px-1.5 py-0 text-[9px] font-medium',
        className
      )}
      title={`Draft objective resource: ${label}`}
    >
      {label}
    </Badge>
  );
}
