import { CalendarDays, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useUpdateMission } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import type { ButtonLoadingState } from '../ui/loading-button.tsx';
import { LoadingButton } from '../ui/loading-button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

type DueDateEditorProps = {
  initialDueDatetime: string | null;
  missionId: string;
};

function parseDueDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fromDateInputValue(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function buildDueDatetime({
  selectedDate,
  currentDueDatetime
}: {
  selectedDate: Date;
  currentDueDatetime: string | null;
}): string {
  if (currentDueDatetime) {
    const current = new Date(currentDueDatetime);
    const next = new Date(current);
    next.setUTCFullYear(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate()
    );
    return next.toISOString();
  }

  return new Date(
    Date.UTC(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 12, 0, 0)
  ).toISOString();
}

function formatDueDateLabel(value: string | null): string {
  const date = parseDueDate(value);
  if (!date) return 'Set due date';
  return `Due ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)}`;
}

export function DueDateEditor({ initialDueDatetime, missionId }: DueDateEditorProps) {
  const update = useUpdateMission(missionId);
  const [open, setOpen] = useState(false);
  const [dueDatetime, setDueDatetime] = useState(initialDueDatetime);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(() =>
    parseDueDate(initialDueDatetime)
  );
  const [saveButtonState, setSaveButtonState] = useState<ButtonLoadingState>('default');
  const [clearButtonState, setClearButtonState] = useState<ButtonLoadingState>('default');

  useEffect(() => {
    setDueDatetime(initialDueDatetime);
    setSelectedDate(parseDueDate(initialDueDatetime));
  }, [initialDueDatetime]);

  async function handleSaveDueDate() {
    if (!selectedDate) return;

    setSaveButtonState('loading');

    try {
      const nextDueDatetime = buildDueDatetime({ selectedDate, currentDueDatetime: dueDatetime });
      await update.mutateAsync({ dueDatetime: nextDueDatetime });
      setDueDatetime(nextDueDatetime);
      setSaveButtonState('success');
      setOpen(false);
    } catch {
      setSaveButtonState('error');
    }
  }

  async function handleClearDueDate() {
    setClearButtonState('loading');

    try {
      await update.mutateAsync({ dueDatetime: null });
      setDueDatetime(null);
      setSelectedDate(undefined);
      setClearButtonState('success');
      setOpen(false);
    } catch {
      setClearButtonState('error');
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted',
              dueDatetime
                ? 'border-sky-400/40 text-sky-700 dark:border-sky-500/30 dark:text-sky-300'
                : 'border-input text-muted-foreground'
            )}
          />
        }
      >
        <CalendarDays className="h-3.5 w-3.5" />
        <span>{formatDueDateLabel(dueDatetime)}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-medium">Next due date</h3>
          <p className="text-xs text-muted-foreground">
            Set a one-time due date without changing the recurring schedule.
          </p>
        </div>

        <div className="p-4">
          <input
            type="date"
            value={selectedDate ? toDateInputValue(selectedDate) : ''}
            onChange={event => {
              setSelectedDate(
                event.target.value ? fromDateInputValue(event.target.value) : undefined
              );
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-3 py-3">
          <LoadingButton
            buttonState={clearButtonState}
            setButtonState={setClearButtonState}
            variant="ghost"
            size="sm"
            text={
              <>
                <X className="h-3.5 w-3.5" />
                Clear
              </>
            }
            loadingText="Clearing..."
            successText="Cleared"
            errorText="Clear failed"
            reset
            disabled={!dueDatetime}
            onClick={handleClearDueDate}
          />
          <LoadingButton
            buttonState={saveButtonState}
            setButtonState={setSaveButtonState}
            size="sm"
            text="Save due date"
            loadingText="Saving..."
            successText="Saved"
            errorText="Save failed"
            reset
            disabled={!selectedDate}
            onClick={handleSaveDueDate}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
