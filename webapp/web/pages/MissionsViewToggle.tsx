import { CalendarDays, LayoutGrid, List } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { BoardView } from './board-shared.ts';

const VIEW_OPTIONS: Array<{
  value: BoardView;
  label: string;
  icon: typeof LayoutGrid;
}> = [
  { value: 'board', label: 'Board', icon: LayoutGrid },
  { value: 'list', label: 'List', icon: List },
  { value: 'calendar', label: 'Calendar', icon: CalendarDays }
];

export function MissionsViewToggle({
  value,
  onChange,
  views = ['board', 'list', 'calendar']
}: {
  value: BoardView;
  onChange: (value: BoardView) => void;
  /** Subset of views to show; My Missions omits calendar until multi-project support ships. */
  views?: BoardView[];
}) {
  const options = VIEW_OPTIONS.filter(option => views.includes(option.value));

  return (
    <div
      className="inline-flex h-9 items-center rounded-lg border border-border bg-muted/40 p-0.5"
      role="tablist"
      aria-label="Mission view"
    >
      {options.map(option => {
        const Icon = option.icon;
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'hover:bg-background/60 hover:text-foreground'
            )}
            onClick={() => onChange(option.value)}
          >
            <Icon className="h-4 w-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
