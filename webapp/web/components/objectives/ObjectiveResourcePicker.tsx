import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import type { ProjectResourceDto } from '../../../shared/contract.ts';
import {
  distinctProjectResourceKeys,
  primaryResourceConnection
} from '../../lib/project-resources.ts';
import { cn } from '../../lib/utils.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';

type ObjectiveResourcePickerProps = {
  resources: ProjectResourceDto[];
  value: string | null;
  onChange: (resourceKey: string | null) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Resource picker for objectives. Rendered only when the project has more than
 * one logical resource key. A null value inherits the project primary resource.
 */
export function ObjectiveResourcePicker({
  resources,
  value,
  onChange,
  disabled = false,
  className
}: ObjectiveResourcePickerProps) {
  const [open, setOpen] = useState(false);
  const resourceKeys = distinctProjectResourceKeys(resources);
  if (resourceKeys.length <= 1) return null;

  const primaryKey = primaryResourceConnection(resources).primary?.resourceKey ?? null;
  const effectiveKey = value ?? primaryKey ?? resourceKeys[0] ?? null;

  const labelsByKey = new Map<string, string>();
  for (const resource of resources) {
    if (!labelsByKey.has(resource.resourceKey)) {
      labelsByKey.set(resource.resourceKey, resource.label?.trim() || resource.resourceKey);
    }
  }

  if (!effectiveKey) return null;

  const currentLabel = labelsByKey.get(effectiveKey) ?? effectiveKey;
  const triggerLabel = `Choose resource: ${currentLabel}`;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={disabled}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm transition-colors',
                'max-w-[230px] @max-[360px]/objective-toolbar:px-2',
                disabled
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-accent hover:text-accent-foreground',
                className
              )}
              aria-label={triggerLabel}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[120px] truncate @max-[360px]/objective-toolbar:hidden">
                {currentLabel}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 @max-[360px]/objective-toolbar:hidden" />
            </DropdownMenuTrigger>
          }
        />
        <TooltipContent side="top">Sets which resource the agent will run against.</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel className="flex items-center">
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="sr-only">Resource</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {resourceKeys.map(key => (
          <DropdownMenuItem
            key={key}
            className="gap-2 text-xs"
            onClick={() => onChange(key === primaryKey ? null : key)}
          >
            <span className="truncate">{labelsByKey.get(key) ?? key}</span>
            {effectiveKey === key ? (
              <Check className="ml-auto h-3 w-3 text-muted-foreground" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
