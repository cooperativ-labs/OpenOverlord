import type { MissionDto } from '../../shared/contract.ts';

export type DayKey = string;

const CALENDAR_DAY_DROPPABLE_PREFIX = 'day:';

const ISO_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function calendarDayDroppableId(dayKey: DayKey): string {
  return `${CALENDAR_DAY_DROPPABLE_PREFIX}${dayKey}`;
}

export function parseCalendarDayDroppableId(id: string): DayKey | null {
  if (!id.startsWith(CALENDAR_DAY_DROPPABLE_PREFIX)) return null;
  return id.slice(CALENDAR_DAY_DROPPABLE_PREFIX.length);
}

export function dayKeyFromDate(date: Date): DayKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDayKey(key: DayKey): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday = 0 … Sunday = 6 (ISO week). */
export function isoWeekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

export function formatWeekdayShort(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
}

export function isoWeekdayLabels(): readonly string[] {
  return ISO_WEEKDAY_LABELS;
}

export function eachMonthInRange({ start, end }: { start: Date; end: Date }): Date[] {
  const months: Date[] = [];
  let current = startOfMonth(start);
  const endMonth = startOfMonth(end);

  while (current <= endMonth) {
    months.push(new Date(current));
    current = addMonths(current, 1);
  }

  return months;
}

export function calendarWindowRange({
  anchor,
  monthsBefore,
  monthsAfter
}: {
  anchor: Date;
  monthsBefore: number;
  monthsAfter: number;
}): { start: Date; end: Date } {
  return {
    start: startOfMonth(addMonths(anchor, -monthsBefore)),
    end: endOfMonth(addMonths(anchor, monthsAfter))
  };
}

/** Week rows for a month, padded to full ISO weeks with adjacent-month days. */
export function getWeeksForMonth(monthDate: Date): Date[][] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = endOfMonth(monthDate);
  const weeks: Date[][] = [];
  let currentWeek: Date[] = [];

  const leadingPad = isoWeekdayIndex(firstOfMonth);
  for (let offset = leadingPad; offset > 0; offset -= 1) {
    currentWeek.push(addDays(firstOfMonth, -offset));
  }

  for (let day = 1; day <= lastOfMonth.getDate(); day += 1) {
    currentWeek.push(new Date(year, month, day));
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  if (currentWeek.length > 0) {
    let cursor = currentWeek[currentWeek.length - 1];
    while (currentWeek.length < 7) {
      cursor = addDays(cursor, 1);
      currentWeek.push(cursor);
    }
    weeks.push(currentWeek);
  }

  return weeks;
}

export function groupMissionsByDay(missions: MissionDto[]): Map<DayKey, MissionDto[]> {
  const map = new Map<DayKey, MissionDto[]>();

  for (const mission of missions) {
    if (!mission.dueDatetime) continue;
    const parsed = new Date(mission.dueDatetime);
    if (Number.isNaN(parsed.getTime())) continue;

    const key = dayKeyFromDate(parsed);
    const bucket = map.get(key) ?? [];
    bucket.push(mission);
    map.set(key, bucket);
  }

  for (const [key, bucket] of map) {
    bucket.sort((left, right) => {
      if (left.boardPosition !== right.boardPosition) {
        return left.boardPosition - right.boardPosition;
      }
      return right.sequenceNumber - left.sequenceNumber;
    });
    map.set(key, bucket);
  }

  return map;
}
