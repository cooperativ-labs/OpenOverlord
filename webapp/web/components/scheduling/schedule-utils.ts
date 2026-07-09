import type { PeriodType, WeekDayType } from '@overlord/automations/scheduling-engine';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LABELS_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;

const ORDINAL_LABELS = ['1st', '2nd', '3rd'] as const;

const PERIOD_INTERVAL_NAMES: Record<PeriodType, { singular: string; plural: string }> = {
  d: { singular: 'day', plural: 'days' },
  w: { singular: 'week', plural: 'weeks' },
  m: { singular: 'month', plural: 'months' }
};

export function getPeriodIntervalName({
  periodType,
  periodInterval
}: {
  periodType: PeriodType;
  periodInterval: number;
}): string {
  const names = PERIOD_INTERVAL_NAMES[periodType];
  return periodInterval === 1 ? names.singular : names.plural;
}

export function getDayLabel(dayNum: number, full = false): string {
  return full ? (DAY_LABELS_FULL[dayNum] ?? '') : (DAY_LABELS[dayNum] ?? '');
}

export function getOrdinalLabel(week: number): string {
  if (week >= 4 && week <= 5) return 'Last';
  return ORDINAL_LABELS[week - 1] ?? `${week}th`;
}

export function formatPeriodType(periodType: PeriodType): string {
  switch (periodType) {
    case 'd':
      return 'Daily';
    case 'w':
      return 'Weekly';
    case 'm':
      return 'Monthly';
    default:
      return 'Schedule';
  }
}

export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  if (hours === undefined || minutes === undefined) return time;
  const h = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  return `${h}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

export function formatDueDatetimeLabel(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

export function summarizeSchedule(schedule: {
  periodType: string;
  periodInterval: number;
  daysOfWeek?: WeekDayType[] | unknown[] | null;
  daysOfMonth?: number[] | null;
  weeksOfMonth?: number[] | null;
}): string {
  const { periodType, periodInterval } = schedule;
  const daysOfWeek = (schedule.daysOfWeek ?? []) as WeekDayType[];
  const daysOfMonth = schedule.daysOfMonth ?? [];
  const weeksOfMonth = schedule.weeksOfMonth ?? [];

  if (periodType === 'd') {
    const times = daysOfWeek[0]?.times;
    const timeStr = times?.length ? ` at ${formatTime(times[0])}` : '';

    if (periodInterval === 1) {
      return `Every day${timeStr}`;
    }
    return `Every ${periodInterval} days${timeStr}`;
  }

  if (periodType === 'w') {
    const dayNames = daysOfWeek.map(d => getDayLabel(d.dayNum)).join(', ');
    const times = daysOfWeek[0]?.times;
    const timeStr = times?.length ? ` at ${formatTime(times[0])}` : '';

    if (periodInterval === 1) return `Weekly on ${dayNames}${timeStr}`;
    return `Every ${periodInterval} weeks on ${dayNames}${timeStr}`;
  }

  if (periodType === 'm') {
    if (daysOfMonth.length > 0) {
      const dayStrs = daysOfMonth.map(d => (d === 32 ? 'last day' : `${d}`));
      const prefix = periodInterval === 1 ? 'Monthly' : `Every ${periodInterval} months`;
      return `${prefix} on day ${dayStrs.join(', ')}`;
    }

    if (weeksOfMonth.length > 0 && daysOfWeek.length > 0) {
      const weekStrs = weeksOfMonth.map(w => getOrdinalLabel(w));
      const dayNames = daysOfWeek.map(d => getDayLabel(d.dayNum)).join(', ');
      const prefix = periodInterval === 1 ? 'Monthly' : `Every ${periodInterval} months`;
      return `${prefix} on ${weekStrs.join(', ')} ${dayNames}`;
    }

    return periodInterval === 1 ? 'Monthly' : `Every ${periodInterval} months`;
  }

  return 'Schedule';
}

export function getDefaultSchedule() {
  return {
    periodType: 'w' as PeriodType,
    periodInterval: 1,
    daysOfWeek: [{ dayNum: 1 as const, times: ['09:00'] }],
    daysOfMonth: undefined as number[] | undefined,
    weeksOfMonth: undefined as number[] | undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}
