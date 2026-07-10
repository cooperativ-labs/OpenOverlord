import { Check } from 'lucide-react';

import { distinctProjectResourceKeys, primaryResourceConnection } from '@/lib/project-resources.ts';
import { cn } from '@/lib/utils';

import type { ProjectResourceDto } from '../../../shared/contract.ts';

type ResourcePickerPanelProps = {
  resources: ProjectResourceDto[];
  /** Selected resource key; null inherits the project primary resource. */
  value: string | null;
  onSelect: (resourceKey: string | null) => void;
};

/**
 * Resource picker panel for the quick-task bar. Mirrors ObjectiveResourcePicker:
 * only meaningful when the project has more than one logical resource key, and a
 * null value inherits the project primary resource.
 */
export function ResourcePickerPanel({ resources, value, onSelect }: ResourcePickerPanelProps) {
  const resourceKeys = distinctProjectResourceKeys(resources);
  const primaryKey = primaryResourceConnection(resources).primary?.resourceKey ?? null;
  const effectiveKey = value ?? primaryKey ?? resourceKeys[0] ?? null;

  const labelsByKey = new Map<string, string>();
  for (const resource of resources) {
    if (!labelsByKey.has(resource.resourceKey)) {
      labelsByKey.set(resource.resourceKey, resource.label?.trim() || resource.resourceKey);
    }
  }

  return (
    <div className="electron-no-drag rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur-md">
      {resourceKeys.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No resources</p>
      ) : (
        resourceKeys.map(key => (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key === primaryKey ? null : key)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
              effectiveKey === key && 'bg-muted/60'
            )}
          >
            <span className="truncate">{labelsByKey.get(key) ?? key}</span>
            {effectiveKey === key ? (
              <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        ))
      )}
    </div>
  );
}
