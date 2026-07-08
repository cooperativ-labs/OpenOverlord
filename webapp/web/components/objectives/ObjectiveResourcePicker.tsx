import type { ProjectResourceDto } from '../../../shared/contract.ts';
import { distinctProjectResourceKeys } from '../../lib/project-resources.ts';

type ObjectiveResourcePickerProps = {
  resources: ProjectResourceDto[];
  value: string | null;
  onChange: (resourceKey: string | null) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Resource picker for objectives. Rendered only when the project has more than
 * one logical resource key; null means inherit the project primary.
 */
export function ObjectiveResourcePicker({
  resources,
  value,
  onChange,
  disabled = false,
  className
}: ObjectiveResourcePickerProps) {
  const resourceKeys = distinctProjectResourceKeys(resources);
  if (resourceKeys.length <= 1) return null;

  const labelsByKey = new Map<string, string>();
  for (const resource of resources) {
    if (!labelsByKey.has(resource.resourceKey)) {
      labelsByKey.set(resource.resourceKey, resource.label?.trim() || resource.resourceKey);
    }
  }

  return (


    <select
      className="h-8 min-w-40 rounded-md border border-input bg-background px-2 text-xs shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      value={value ?? ''}
      disabled={disabled}
      onChange={event => onChange(event.target.value.trim() || null)}
    >
      <option value="">Primary (default)</option>
      {resourceKeys.map(key => (
        <option key={key} value={key}>
          {labelsByKey.get(key) ?? key}
        </option>
      ))}
    </select>

  );
}
