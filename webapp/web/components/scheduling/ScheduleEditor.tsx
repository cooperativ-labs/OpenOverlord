import type { PeriodType, WeekDayType } from '@overlord/automations';
import { CalendarClock, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkspaceStatusDto } from '../../../shared/contract.ts';
import { api } from '../../lib/api.ts';
import {
  useClearMissionSchedule,
  usePreviewScheduleDueDatetime,
  useUpsertMissionSchedule
} from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import type { ButtonLoadingState } from '../ui/loading-button.tsx';
import { LoadingButton } from '../ui/loading-button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';

import {
  createDefaultState,
  createStateFromInitialSchedule,
  getValidationMessage,
  LAST_DAY_OF_MONTH,
  LAST_WEEK_OF_MONTH,
  normalizeDaysOfMonth,
  normalizeWeeksOfMonth,
  type ScheduleEditorInitialSchedule,
  type ScheduleState,
  stateToInput
} from './schedule-editor-helpers.ts';
import {
  formatDueDatetimeLabel,
  getPeriodIntervalName,
  summarizeSchedule
} from './schedule-utils.ts';
import { DayToggles, MonthDayToggles, WeekOfMonthToggles } from './ScheduleToggles.tsx';

export type { ScheduleEditorInitialSchedule } from './schedule-editor-helpers.ts';

type ScheduleEditorProps = {
  missionId: string;
  hasSchedule: boolean;
  currentDueDatetime: string | null;
  statuses: WorkspaceStatusDto[];
  initialSchedule?: ScheduleEditorInitialSchedule | null;
  onScheduleChange?: (hasSchedule: boolean) => void;
};

export function ScheduleEditor({
  missionId,
  hasSchedule,
  currentDueDatetime,
  statuses,
  initialSchedule = null,
  onScheduleChange
}: ScheduleEditorProps) {
  const upsert = useUpsertMissionSchedule(missionId);
  const clear = useClearMissionSchedule(missionId);
  const { mutateAsync: previewScheduleDueDatetime, isPending: isPreviewPending } =
    usePreviewScheduleDueDatetime();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearButtonState, setClearButtonState] = useState<ButtonLoadingState>('default');
  const [saveButtonState, setSaveButtonState] = useState<ButtonLoadingState>('default');
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [previewDueDatetime, setPreviewDueDatetime] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(() => Boolean(initialSchedule));
  const [schedule, setSchedule] = useState<ScheduleState | null>(() =>
    initialSchedule ? createStateFromInitialSchedule(initialSchedule) : null
  );
  const scheduleRef = useRef<ScheduleState | null>(
    initialSchedule ? createStateFromInitialSchedule(initialSchedule) : null
  );
  const savedScheduleRef = useRef<ScheduleState | null>(
    initialSchedule ? createStateFromInitialSchedule(initialSchedule) : null
  );
  const initialHashRef = useRef<string>(
    initialSchedule ? JSON.stringify(createStateFromInitialSchedule(initialSchedule)) : ''
  );
  const [optimisticHasSchedule, setOptimisticHasSchedule] = useState(hasSchedule);

  useEffect(() => {
    setOptimisticHasSchedule(hasSchedule);
  }, [hasSchedule]);

  useEffect(() => {
    if (!initialSchedule) return;

    const nextState = createStateFromInitialSchedule(initialSchedule);
    setSchedule(nextState);
    scheduleRef.current = nextState;
    savedScheduleRef.current = nextState;
    initialHashRef.current = JSON.stringify(nextState);
    setLoaded(true);
  }, [initialSchedule]);

  const hashState = useCallback((state: ScheduleState | null): string => {
    if (!state) return '';
    return JSON.stringify(state);
  }, []);

  useEffect(() => {
    if (!open || loaded) return;

    let cancelled = false;
    setLoading(true);

    api
      .getMissionSchedule(missionId)
      .then(payload => {
        if (cancelled) return;

        if (payload.schedule) {
          const state = createStateFromInitialSchedule({
            periodType: payload.schedule.periodType,
            periodInterval: payload.schedule.periodInterval,
            daysOfWeek: payload.schedule.daysOfWeek as WeekDayType[],
            daysOfMonth: payload.schedule.daysOfMonth,
            weeksOfMonth: payload.schedule.weeksOfMonth,
            timezone: payload.schedule.timezone,
            nextStatusId: payload.schedule.nextStatusId
          });
          setSchedule(state);
          scheduleRef.current = state;
          savedScheduleRef.current = state;
          initialHashRef.current = JSON.stringify(state);
        } else {
          const state = createDefaultState();
          setSchedule(state);
          scheduleRef.current = state;
          savedScheduleRef.current = null;
          initialHashRef.current = '';
        }

        setLoaded(true);
        setSaveButtonState('default');
      })
      .catch(() => {
        if (cancelled) return;
        const state = createDefaultState();
        setSchedule(state);
        scheduleRef.current = state;
        savedScheduleRef.current = null;
        initialHashRef.current = JSON.stringify(state);
        setLoaded(true);
        setWarningMessage(
          'We could not load the saved schedule. You can try again by closing and reopening the scheduler.'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loaded, missionId, open]);

  useEffect(() => {
    if (!open || !schedule) {
      setPreviewDueDatetime(null);
      return;
    }

    const validationMessage = getValidationMessage(schedule);
    if (validationMessage) {
      setPreviewDueDatetime(null);
      return;
    }

    const input = stateToInput(schedule);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      previewScheduleDueDatetime({
        schedule: input,
        itemDueDatetime: currentDueDatetime
      })
        .then(result => {
          if (!cancelled) setPreviewDueDatetime(result.dueDatetime);
        })
        .catch(() => {
          if (!cancelled) setPreviewDueDatetime(null);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [currentDueDatetime, open, previewScheduleDueDatetime, schedule]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setLoaded(false);
      setSaveButtonState('default');
      scheduleRef.current = savedScheduleRef.current;
      setSchedule(savedScheduleRef.current);
      setPreviewDueDatetime(null);
    }
  }, []);

  function updateSchedule(partial: Partial<ScheduleState>) {
    setSaveButtonState('default');
    setSchedule(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      scheduleRef.current = next;
      return next;
    });
  }

  function toggleDay(day: WeekDayType['dayNum']) {
    setSaveButtonState('default');
    setSchedule(prev => {
      if (!prev) return prev;
      const existing = prev.daysOfWeek.find(d => d.dayNum === day);
      const next = existing
        ? { ...prev, daysOfWeek: prev.daysOfWeek.filter(d => d.dayNum !== day) }
        : {
          ...prev,
          daysOfWeek: [...prev.daysOfWeek, { dayNum: day, times: [prev.time || '09:00'] }]
        };
      scheduleRef.current = next;
      return next;
    });
  }

  function toggleMonthDay(day: number) {
    setSaveButtonState('default');
    setSchedule(prev => {
      if (!prev) return prev;
      const current = prev.daysOfMonth ?? [];
      const normalizedDay = day >= 29 && day <= 31 ? LAST_DAY_OF_MONTH : day;
      const next = current.includes(normalizedDay)
        ? { ...prev, daysOfMonth: current.filter(d => d !== normalizedDay) }
        : { ...prev, daysOfMonth: normalizeDaysOfMonth([...current, normalizedDay]) };
      scheduleRef.current = next;
      return next;
    });
  }

  function toggleWeekOfMonth(week: number) {
    setSaveButtonState('default');
    setSchedule(prev => {
      if (!prev) return prev;
      const current = prev.weeksOfMonth ?? [];
      const normalizedWeek = week >= 4 && week <= 5 ? LAST_WEEK_OF_MONTH : week;
      const next = current.includes(normalizedWeek)
        ? { ...prev, weeksOfMonth: current.filter(w => w !== normalizedWeek) }
        : { ...prev, weeksOfMonth: normalizeWeeksOfMonth([...current, normalizedWeek]) };
      scheduleRef.current = next;
      return next;
    });
  }

  async function handleSaveSchedule() {
    const currentSchedule = scheduleRef.current ?? schedule;
    if (!currentSchedule) return;

    const validationMessage = getValidationMessage(currentSchedule);
    if (validationMessage) {
      setWarningMessage(validationMessage);
      setSaveButtonState('error');
      return;
    }

    const normalizedSchedule = {
      ...currentSchedule,
      daysOfMonth: normalizeDaysOfMonth(currentSchedule.daysOfMonth),
      weeksOfMonth: normalizeWeeksOfMonth(currentSchedule.weeksOfMonth)
    };
    const currentHash = hashState(normalizedSchedule);
    const input = stateToInput(normalizedSchedule);

    setSaveButtonState('loading');
    setSaving(true);
    setOptimisticHasSchedule(true);
    onScheduleChange?.(true);
    try {
      await upsert.mutateAsync(input);
      setSchedule(normalizedSchedule);
      scheduleRef.current = normalizedSchedule;
      savedScheduleRef.current = normalizedSchedule;
      initialHashRef.current = currentHash;
      setSaveButtonState('success');
    } catch {
      setSaveButtonState('error');
      setWarningMessage(
        'We could not save this schedule. Please check the settings and try again.'
      );
      setOptimisticHasSchedule(hasSchedule);
      onScheduleChange?.(hasSchedule);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearSchedule() {
    setClearButtonState('loading');
    setSaving(true);
    setOptimisticHasSchedule(false);
    onScheduleChange?.(false);
    try {
      await clear.mutateAsync();
      setClearButtonState('success');
      initialHashRef.current = '';
      scheduleRef.current = null;
      savedScheduleRef.current = null;
      setSchedule(null);
      setLoaded(false);
      setOpen(false);
    } catch {
      setClearButtonState('error');
      setWarningMessage('We could not remove this schedule. Please try again.');
      setOptimisticHasSchedule(hasSchedule);
      onScheduleChange?.(hasSchedule);
    } finally {
      setSaving(false);
    }
  }

  const selectedDays = new Set(schedule?.daysOfWeek.map(d => d.dayNum) ?? []);
  const selectedMonthDays = new Set(schedule?.daysOfMonth ?? []);
  const selectedWeeks = new Set(schedule?.weeksOfMonth ?? []);
  const hasUnsavedChanges = schedule ? hashState(schedule) !== initialHashRef.current : false;
  const effectiveSaveButtonState =
    !hasUnsavedChanges && saveButtonState === 'default' ? 'disabled' : saveButtonState;

  const summaryText = schedule
    ? summarizeSchedule({
      periodType: schedule.periodType,
      periodInterval: schedule.periodInterval,
      daysOfWeek: schedule.daysOfWeek,
      daysOfMonth: schedule.daysOfMonth,
      weeksOfMonth: schedule.weeksOfMonth
    })
    : null;

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted',
                optimisticHasSchedule
                  ? 'border-violet-400/40 text-violet-600 dark:border-violet-500/30 dark:text-violet-400'
                  : 'border-input text-muted-foreground'
              )}
            />
          }
        >
          <CalendarClock className="h-3.5 w-3.5" />
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : optimisticHasSchedule && summaryText ? (
            <span className="max-w-[200px] truncate">{summaryText}</span>
          ) : (
            <span>Add schedule</span>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : schedule ? (
            <div className="flex flex-col">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h3 className="text-sm font-medium">Schedule</h3>
                {optimisticHasSchedule && (
                  <LoadingButton
                    buttonState={clearButtonState}
                    setButtonState={setClearButtonState}
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
                    text={
                      <>
                        <Trash2 className="h-3 w-3" />
                        Remove
                      </>
                    }
                    loadingText={
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Removing...
                      </>
                    }
                    successText="Removed"
                    errorText="Remove failed"
                    reset
                    onClick={handleClearSchedule}
                  />
                )}
              </div>

              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">Every</Label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={schedule.periodInterval}
                    onChange={event =>
                      updateSchedule({
                        periodInterval: Math.max(1, Math.min(365, Number(event.target.value) || 1))
                      })
                    }
                    className="h-8 w-16 text-center text-xs"
                  />
                  <Select
                    value={schedule.periodType}
                    onValueChange={value => {
                      const periodType = value as PeriodType;
                      updateSchedule({
                        periodType,
                        ...(periodType === 'm'
                          ? { daysOfWeek: [], daysOfMonth: [], weeksOfMonth: [] }
                          : { daysOfMonth: undefined, weeksOfMonth: undefined })
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-[100px] text-xs">
                      <SelectValue>
                        {getPeriodIntervalName({
                          periodType: schedule.periodType,
                          periodInterval: schedule.periodInterval
                        })}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="d">
                        {getPeriodIntervalName({
                          periodType: 'd',
                          periodInterval: schedule.periodInterval
                        })}
                      </SelectItem>
                      <SelectItem value="w">
                        {getPeriodIntervalName({
                          periodType: 'w',
                          periodInterval: schedule.periodInterval
                        })}
                      </SelectItem>
                      <SelectItem value="m">
                        {getPeriodIntervalName({
                          periodType: 'm',
                          periodInterval: schedule.periodInterval
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {schedule.periodType === 'w' && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">On</Label>
                    <DayToggles selectedDays={selectedDays} onToggle={toggleDay} />
                  </div>
                )}

                {schedule.periodType === 'm' && (
                  <div className="flex flex-col gap-3">
                    <div className="flex gap-1">
                      <Badge
                        variant={schedule.monthlyMode === 'dayOfMonth' ? 'default' : 'outline'}
                        className="cursor-pointer select-none"
                        onClick={() => updateSchedule({ monthlyMode: 'dayOfMonth' })}
                      >
                        Day of month
                      </Badge>
                      <Badge
                        variant={schedule.monthlyMode === 'weekOfMonth' ? 'default' : 'outline'}
                        className="cursor-pointer select-none"
                        onClick={() => updateSchedule({ monthlyMode: 'weekOfMonth' })}
                      >
                        Week + day
                      </Badge>
                    </div>

                    {schedule.monthlyMode === 'dayOfMonth' ? (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Days</Label>
                        <MonthDayToggles
                          selectedDays={selectedMonthDays}
                          onToggle={toggleMonthDay}
                        />
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-xs text-muted-foreground">Weeks</Label>
                          <WeekOfMonthToggles
                            selectedWeeks={selectedWeeks}
                            onToggle={toggleWeekOfMonth}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-xs text-muted-foreground">On</Label>
                          <DayToggles selectedDays={selectedDays} onToggle={toggleDay} />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">At</Label>
                  <Input
                    type="time"
                    value={schedule.time}
                    onChange={event => updateSchedule({ time: event.target.value })}
                    className="h-8 w-auto text-xs"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">Timezone</Label>
                  <span className="truncate text-xs text-muted-foreground">
                    {schedule.timezone}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Duplicate lands in</Label>
                  <Select
                    value={schedule.nextStatusId ?? '__default__'}
                    onValueChange={value =>
                      updateSchedule({
                        nextStatusId: value === '__default__' ? null : value
                      })
                    }
                  >
                    <SelectTrigger className="h-8 w-full text-xs">
                      <SelectValue placeholder="Workspace default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Workspace default</SelectItem>
                      {statuses.map(status => (
                        <SelectItem key={status.id} value={status.id}>
                          {status.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {(previewDueDatetime || isPreviewPending) && (
                  <p className="rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                    {previewDueDatetime
                      ? `Next due: ${formatDueDatetimeLabel(previewDueDatetime)}`
                      : 'Computing next due date…'}
                  </p>
                )}
              </div>

              <div className="flex border-t px-4 py-3">
                <LoadingButton
                  buttonState={effectiveSaveButtonState}
                  setButtonState={setSaveButtonState}
                  size="sm"
                  className="ml-auto h-8 text-xs"
                  text="Save schedule"
                  loadingText={
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Saving...
                    </>
                  }
                  successText="Saved"
                  errorText="Save failed"
                  reset
                  onClick={handleSaveSchedule}
                />
              </div>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      <Dialog
        open={warningMessage !== null}
        onOpenChange={nextOpen => !nextOpen && setWarningMessage(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-amber-500" />
              Schedule needs attention
            </DialogTitle>
            <DialogDescription>{warningMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setWarningMessage(null)}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
