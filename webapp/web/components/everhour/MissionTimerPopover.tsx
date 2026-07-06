import type { EverhourTimeRecordDto } from '@overlord/contract/ext/everhour';
import { Check, Clock, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  useAddMissionTime,
  useDeleteMissionTime,
  useStartMissionTimer,
  useStopMissionTimer,
  useUpdateMissionTime
} from '@/lib/queries';
import { cn } from '@/lib/utils';

import {
  formatClock,
  formatHoursMinutes,
  parseDurationToSeconds,
  useLiveSeconds
} from '../../lib/everhour.ts';

import { useMissionTimerControls } from './MissionTimerButtons.tsx';

function RecordRow({ missionId, record }: { missionId: string; record: EverhourTimeRecordDto }) {
  const update = useUpdateMissionTime(missionId);
  const remove = useDeleteMissionTime(missionId);
  const [editing, setEditing] = useState(false);
  const [duration, setDuration] = useState(formatHoursMinutes(record.timeSeconds));
  const [comment, setComment] = useState(record.comment ?? '');
  const [error, setError] = useState<string | null>(null);

  function beginEdit() {
    setDuration(formatHoursMinutes(record.timeSeconds));
    setComment(record.comment ?? '');
    setError(null);
    setEditing(true);
  }

  async function save() {
    const seconds = parseDurationToSeconds(duration);
    if (seconds === null) {
      setError('Use a format like 1h 30m, 90m, or 1:30.');
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ recordId: record.id, body: { timeSeconds: seconds, comment } });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    }
  }

  if (editing) {
    return (
      <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={duration}
            onChange={e => setDuration(e.target.value)}
            placeholder="1h 30m"
            className="h-7 w-24 text-xs"
            autoFocus
          />
          <Input
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Comment"
            className="h-7 flex-1 text-xs"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-7 w-7 text-emerald-600"
            aria-label="Save time record"
            disabled={update.isPending}
            onClick={save}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-7 w-7"
            aria-label="Cancel edit"
            onClick={() => setEditing(false)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/50">
      <span className="w-14 shrink-0 tabular-nums font-medium">
        {formatHoursMinutes(record.timeSeconds)}
      </span>
      <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{record.date}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={record.comment ?? ''}>
        {record.comment || '—'}
      </span>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Edit time record"
          onClick={beginEdit}
        >
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          aria-label="Delete time record"
          disabled={remove.isPending}
          onClick={() => remove.mutate(record.id)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function AddTimeForm({ missionId }: { missionId: string }) {
  const add = useAddMissionTime(missionId);
  const today = new Date().toISOString().slice(0, 10);
  const [duration, setDuration] = useState('');
  const [date, setDate] = useState(today);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const seconds = parseDurationToSeconds(duration);
    if (seconds === null) {
      setError('Use a format like 1h 30m, 90m, or 1:30.');
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({ timeSeconds: seconds, date, comment: comment || undefined });
      setDuration('');
      setComment('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add time.');
    }
  }

  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={duration}
          onChange={e => setDuration(e.target.value)}
          placeholder="1h 30m"
          className="h-7 w-24 text-xs"
          onKeyDown={e => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <Input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="h-7 w-32 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1"
          disabled={add.isPending}
          onClick={submit}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      <Input
        value={comment}
        onChange={e => setComment(e.target.value)}
        placeholder="Comment (optional)"
        className="h-7 text-xs"
      />
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function PopoverBody({
  missionId,
  state,
  dataUpdatedAt
}: {
  missionId: string;
  state: ReturnType<typeof useMissionTimerControls>['state'];
  dataUpdatedAt: number;
}) {
  const start = useStartMissionTimer(missionId);
  const stop = useStopMissionTimer(missionId);

  const running = Boolean(state?.runningTimer);
  const liveSeconds = useLiveSeconds(
    state?.runningTimer?.durationSeconds ?? 0,
    dataUpdatedAt,
    running
  );
  const busy = start.isPending || stop.isPending;

  if (state && !state.projectLinked) {
    return (
      <p className="text-xs text-muted-foreground">
        Link this project to an Everhour project in <strong>Project settings → General</strong> to
        track time on its missions.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => (running ? stop.mutate() : start.mutate())}
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium tabular-nums transition-colors disabled:opacity-50',
            running
              ? 'border-red-500/40 bg-red-500/15 text-red-500 hover:bg-red-500/25'
              : 'border-border text-muted-foreground hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-500'
          )}
        >
          {running ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
          {running ? formatClock(liveSeconds) : 'Start timer'}
        </button>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {formatHoursMinutes(state?.totalSeconds ?? 0)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
        </div>
      </div>

      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {state?.records.length ? (
          state.records.map(record => (
            <RecordRow key={record.id} missionId={missionId} record={record} />
          ))
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">No time logged yet.</p>
        )}
      </div>

      <AddTimeForm missionId={missionId} />
    </div>
  );
}

/**
 * Popover entrypoint for mission time tracking. Renders a compact trigger that
 * reflects the running state, and the full timer/records UI inside. Renders
 * nothing when the workspace has no Everhour API key.
 */
export function MissionTimerPopover({ missionId }: { missionId: string }) {
  const [open, setOpen] = useState(false);
  const { connected, running, liveSeconds, state, dataUpdatedAt } = useMissionTimerControls(
    missionId,
    {
      poll: open
    }
  );
  if (!connected) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Mission time tracking"
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors',
              running
                ? 'border-red-500/40 bg-red-500/15 text-red-500 hover:bg-red-500/25'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          />
        }
      >
        <Clock className="h-3.5 w-3.5" />
        <span>{running ? formatClock(liveSeconds) : 'Time'}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <div className="mb-2 text-sm font-medium">Time tracking</div>
        {open ? (
          <PopoverBody missionId={missionId} state={state} dataUpdatedAt={dataUpdatedAt} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
