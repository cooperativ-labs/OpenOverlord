import { scheduleInputSchema } from './helpers/scheduleSchema.ts';
import { sortTimes } from './helpers/sortTimes.ts';
import type { DayNumber, NormalizedSchedule, ScheduleLike, WeekDayType } from './helpers/types.ts';

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const MAX_DAILY_SEARCH_DAYS = 366 * 3;
const MAX_WEEKLY_SEARCH_DAYS = 366 * 6;
const MAX_MONTHLY_SEARCH_MONTHS = 12 * 10;

function parseTimeString(value: string) {
  const [hours, minutes, seconds = '00'] = value.split(':');

  return {
    hour: Number.parseInt(hours ?? '0', 10),
    minute: Number.parseInt(minutes ?? '0', 10),
    second: Number.parseInt(seconds, 10)
  };
}

function toUtcDayNumber(year: number, month: number, day: number) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function addLocalDays(parts: Pick<LocalDateParts, 'year' | 'month' | 'day'>, amount: number) {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}

function addLocalMonths(parts: Pick<LocalDateParts, 'year' | 'month'>, amount: number) {
  const totalMonths = parts.year * 12 + (parts.month - 1) + amount;

  return {
    year: Math.floor(totalMonths / 12),
    month: (totalMonths % 12) + 1
  };
}

function monthsBetween(
  start: Pick<LocalDateParts, 'year' | 'month'>,
  end: Pick<LocalDateParts, 'year' | 'month'>
) {
  return (end.year - start.year) * 12 + (end.month - start.month);
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getWeekday(year: number, month: number, day: number): DayNumber {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as DayNumber;
}

function getZonedParts(date: Date, timezone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return {
    year: Number.parseInt(values.year ?? '0', 10),
    month: Number.parseInt(values.month ?? '0', 10),
    day: Number.parseInt(values.day ?? '0', 10),
    hour: Number.parseInt(values.hour ?? '0', 10),
    minute: Number.parseInt(values.minute ?? '0', 10),
    second: Number.parseInt(values.second ?? '0', 10)
  };
}

function zonedDateTimeToUtc(parts: LocalDateParts, timezone: string) {
  let guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedParts(guess, timezone);
    const desiredMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const actualMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const delta = desiredMs - actualMs;

    if (delta === 0) {
      return guess;
    }

    guess = new Date(guess.getTime() + delta);
  }

  return guess;
}

function buildCandidateUtc(
  timezone: string,
  date: Pick<LocalDateParts, 'year' | 'month' | 'day'>,
  time: string
) {
  const parsedTime = parseTimeString(time);

  return zonedDateTimeToUtc(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      second: parsedTime.second
    },
    timezone
  );
}

function normalizeSchedule(schedule: ScheduleLike): NormalizedSchedule {
  const parsed = scheduleInputSchema.safeParse({
    name: schedule.name ?? undefined,
    periodType: schedule.periodType,
    periodInterval: schedule.periodInterval,
    weeksOfMonth: schedule.weeksOfMonth ?? undefined,
    daysOfMonth: schedule.daysOfMonth ?? undefined,
    daysOfWeek:
      schedule.daysOfWeek?.map(day => ({
        dayNum:
          typeof day?.dayNum === 'number'
            ? day.dayNum
            : typeof day?.day_num === 'number'
              ? day.day_num
              : undefined,
        times: day?.times ?? undefined
      })) ?? undefined,
    timezone: schedule.timezone,
    startDate: schedule.startDate ?? schedule.start_date ?? undefined
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid schedule.');
  }

  const daysOfWeek = [...(parsed.data.daysOfWeek ?? [])]
    .map(day => ({
      dayNum: day.dayNum as DayNumber,
      times: sortTimes([...new Set(day.times)])
    }))
    .sort((left, right) => left.dayNum - right.dayNum);

  const daysOfMonth = [...new Set(parsed.data.daysOfMonth ?? [])].sort(
    (left, right) => left - right
  );
  const weeksOfMonth = [...new Set(parsed.data.weeksOfMonth ?? [])].sort(
    (left, right) => left - right
  );

  return {
    name: parsed.data.name?.trim() || null,
    periodType: parsed.data.periodType,
    periodInterval: parsed.data.periodInterval,
    daysOfMonth,
    daysOfWeek,
    weeksOfMonth,
    timezone: parsed.data.timezone,
    startDate:
      parsed.data.startDate instanceof Date
        ? parsed.data.startDate
        : parsed.data.startDate
          ? new Date(parsed.data.startDate)
          : null
  };
}

function getReferenceDate(schedule: NormalizedSchedule, itemDueDatetime?: Date | null) {
  return itemDueDatetime ?? schedule.startDate ?? new Date();
}

function getSearchStart(schedule: NormalizedSchedule, itemDueDatetime?: Date | null) {
  const reference = getReferenceDate(schedule, itemDueDatetime);
  return new Date(reference.getTime() + 1000);
}

function getAnchorDate(schedule: NormalizedSchedule, itemDueDatetime?: Date | null) {
  return schedule.startDate ?? itemDueDatetime ?? new Date();
}

function findWeekdaySchedule(daysOfWeek: WeekDayType[], dayNum: DayNumber) {
  return daysOfWeek.find(day => day.dayNum === dayNum);
}

function getOccurrencesForWeekdayInMonth(year: number, month: number, dayNum: DayNumber) {
  const lastDay = lastDayOfMonth(year, month);
  const occurrences: number[] = [];

  for (let day = 1; day <= lastDay; day += 1) {
    if (getWeekday(year, month, day) === dayNum) {
      occurrences.push(day);
    }
  }

  return occurrences;
}

function getCandidateDaysForMonthlyWeekRule(
  year: number,
  month: number,
  daysOfWeek: WeekDayType[],
  weeksOfMonth: number[]
) {
  const candidates = new Map<
    string,
    { year: number; month: number; day: number; times: string[] }
  >();

  for (const weekday of daysOfWeek) {
    const occurrences = getOccurrencesForWeekdayInMonth(year, month, weekday.dayNum);

    if (occurrences.length === 0) {
      continue;
    }

    for (const week of weeksOfMonth) {
      const occurrenceIndex = Math.min(week, occurrences.length) - 1;
      const day = occurrences[occurrenceIndex];

      if (day === undefined) {
        continue;
      }

      const key = `${year}-${month}-${day}-${weekday.dayNum}`;

      candidates.set(key, {
        year,
        month,
        day,
        times: weekday.times
      });
    }
  }

  return [...candidates.values()].sort((left, right) => {
    const leftValue = Date.UTC(left.year, left.month - 1, left.day);
    const rightValue = Date.UTC(right.year, right.month - 1, right.day);

    return leftValue - rightValue;
  });
}

function findNextDailyOccurrence(schedule: NormalizedSchedule, itemDueDatetime?: Date | null) {
  const timezone = schedule.timezone;
  const searchStart = getSearchStart(schedule, itemDueDatetime);
  const searchStartLocal = getZonedParts(searchStart, timezone);
  const anchorLocal = getZonedParts(getAnchorDate(schedule, itemDueDatetime), timezone);
  const defaultTimes = schedule.daysOfWeek[0]?.times;

  if (!defaultTimes || defaultTimes.length === 0) {
    throw new Error('Daily schedules require a default day with times.');
  }

  for (let offset = 0; offset <= MAX_DAILY_SEARCH_DAYS; offset += 1) {
    const date = addLocalDays(searchStartLocal, offset);
    const daysFromAnchor =
      toUtcDayNumber(date.year, date.month, date.day) -
      toUtcDayNumber(anchorLocal.year, anchorLocal.month, anchorLocal.day);

    if (daysFromAnchor < 0 || daysFromAnchor % schedule.periodInterval !== 0) {
      continue;
    }

    for (const time of defaultTimes) {
      const candidate = buildCandidateUtc(timezone, date, time);

      if (candidate.getTime() > searchStart.getTime()) {
        return candidate;
      }
    }
  }

  throw new Error('Failed to generate the next daily occurrence.');
}

function findNextWeeklyOccurrence(schedule: NormalizedSchedule, itemDueDatetime?: Date | null) {
  const timezone = schedule.timezone;
  const searchStart = getSearchStart(schedule, itemDueDatetime);
  const searchStartLocal = getZonedParts(searchStart, timezone);
  const anchorLocal = getZonedParts(getAnchorDate(schedule, itemDueDatetime), timezone);
  const anchorWeekStart = addLocalDays(
    anchorLocal,
    -getWeekday(anchorLocal.year, anchorLocal.month, anchorLocal.day)
  );

  for (let offset = 0; offset <= MAX_WEEKLY_SEARCH_DAYS; offset += 1) {
    const date = addLocalDays(searchStartLocal, offset);
    const dayNum = getWeekday(date.year, date.month, date.day);
    const daySchedule = findWeekdaySchedule(schedule.daysOfWeek, dayNum);

    if (!daySchedule) {
      continue;
    }

    const candidateWeekStart = addLocalDays(date, -dayNum);
    const weeksFromAnchor = Math.floor(
      (toUtcDayNumber(candidateWeekStart.year, candidateWeekStart.month, candidateWeekStart.day) -
        toUtcDayNumber(anchorWeekStart.year, anchorWeekStart.month, anchorWeekStart.day)) /
        7
    );

    if (weeksFromAnchor < 0 || weeksFromAnchor % schedule.periodInterval !== 0) {
      continue;
    }

    for (const time of daySchedule.times) {
      const candidate = buildCandidateUtc(timezone, date, time);

      if (candidate.getTime() > searchStart.getTime()) {
        return candidate;
      }
    }
  }

  throw new Error('Failed to generate the next weekly occurrence.');
}

function resolveMonthDays(daysOfMonth: number[], year: number, month: number) {
  const monthLastDay = lastDayOfMonth(year, month);
  const resolved = new Set<number>();

  for (const day of daysOfMonth) {
    if (day === 32) {
      resolved.add(monthLastDay);
      continue;
    }

    if (day <= monthLastDay) {
      resolved.add(day);
    }
  }

  return [...resolved].sort((left, right) => left - right);
}

function findNextMonthlyByDayOccurrence(
  schedule: NormalizedSchedule,
  itemDueDatetime?: Date | null
) {
  const timezone = schedule.timezone;
  const searchStart = getSearchStart(schedule, itemDueDatetime);
  const searchStartLocal = getZonedParts(searchStart, timezone);
  const anchorLocal = getZonedParts(getAnchorDate(schedule, itemDueDatetime), timezone);
  const defaultTimes = schedule.daysOfWeek[0]?.times;

  if (!defaultTimes || defaultTimes.length === 0) {
    throw new Error('Monthly day schedules require a default day with times.');
  }

  for (let offset = 0; offset <= MAX_MONTHLY_SEARCH_MONTHS; offset += 1) {
    const monthParts = addLocalMonths(
      { year: searchStartLocal.year, month: searchStartLocal.month },
      offset
    );
    const monthsFromAnchor = monthsBetween(
      { year: anchorLocal.year, month: anchorLocal.month },
      monthParts
    );

    if (monthsFromAnchor < 0 || monthsFromAnchor % schedule.periodInterval !== 0) {
      continue;
    }

    const monthDays = resolveMonthDays(schedule.daysOfMonth, monthParts.year, monthParts.month);

    for (const day of monthDays) {
      for (const time of defaultTimes) {
        const candidate = buildCandidateUtc(timezone, { ...monthParts, day }, time);

        if (candidate.getTime() > searchStart.getTime()) {
          return candidate;
        }
      }
    }
  }

  throw new Error('Failed to generate the next monthly day occurrence.');
}

function findNextMonthlyByWeekOccurrence(
  schedule: NormalizedSchedule,
  itemDueDatetime?: Date | null
) {
  const timezone = schedule.timezone;
  const searchStart = getSearchStart(schedule, itemDueDatetime);
  const searchStartLocal = getZonedParts(searchStart, timezone);
  const anchorLocal = getZonedParts(getAnchorDate(schedule, itemDueDatetime), timezone);

  for (let offset = 0; offset <= MAX_MONTHLY_SEARCH_MONTHS; offset += 1) {
    const monthParts = addLocalMonths(
      { year: searchStartLocal.year, month: searchStartLocal.month },
      offset
    );
    const monthsFromAnchor = monthsBetween(
      { year: anchorLocal.year, month: anchorLocal.month },
      monthParts
    );

    if (monthsFromAnchor < 0 || monthsFromAnchor % schedule.periodInterval !== 0) {
      continue;
    }

    const candidateDays = getCandidateDaysForMonthlyWeekRule(
      monthParts.year,
      monthParts.month,
      schedule.daysOfWeek,
      schedule.weeksOfMonth
    );

    for (const candidateDay of candidateDays) {
      for (const time of candidateDay.times) {
        const candidate = buildCandidateUtc(timezone, candidateDay, time);

        if (candidate.getTime() > searchStart.getTime()) {
          return candidate;
        }
      }
    }
  }

  throw new Error('Failed to generate the next monthly week occurrence.');
}

export function generateDate({
  schedule,
  itemDueDatetime
}: {
  schedule: ScheduleLike;
  itemDueDatetime?: Date | null;
}) {
  const normalized = normalizeSchedule(schedule);

  switch (normalized.periodType) {
    case 'd':
      return findNextDailyOccurrence(normalized, itemDueDatetime);
    case 'w':
      return findNextWeeklyOccurrence(normalized, itemDueDatetime);
    case 'm':
      if (normalized.daysOfMonth.length > 0) {
        return findNextMonthlyByDayOccurrence(normalized, itemDueDatetime);
      }

      return findNextMonthlyByWeekOccurrence(normalized, itemDueDatetime);
    default:
      throw new Error('Failed to generate date from schedule.');
  }
}

export const genDateFromFailureRepeatSeconds = (failureRepeatSeconds: number): Date => {
  const now = new Date();
  now.setSeconds(now.getSeconds() + failureRepeatSeconds);
  return now;
};
