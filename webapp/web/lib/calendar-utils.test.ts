import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MissionDto } from '../../shared/contract.ts';

import {
  addDays,
  addMonths,
  calendarDayDroppableId,
  calendarWindowRange,
  dayKeyFromDate,
  eachMonthInRange,
  endOfMonth,
  getWeeksForMonth,
  groupMissionsByDay,
  isWeekend,
  parseCalendarDayDroppableId,
  parseDayKey,
  startOfDay,
  startOfMonth,
  weekdayIndex
} from './calendar-utils.ts';

function mission({
  id,
  dueDatetime,
  boardPosition = 0,
  sequenceNumber = 0
}: {
  id: string;
  dueDatetime: string | null;
  boardPosition?: number;
  sequenceNumber?: number;
}): MissionDto {
  return { id, dueDatetime, boardPosition, sequenceNumber } as unknown as MissionDto;
}

describe('dayKeyFromDate', () => {
  it('formats local calendar dates as YYYY-MM-DD', () => {
    assert.equal(dayKeyFromDate(new Date(2026, 2, 4)), '2026-03-04');
    assert.equal(dayKeyFromDate(new Date(2026, 11, 31)), '2026-12-31');
  });

  it('round-trips through parseDayKey', () => {
    const date = new Date(2026, 6, 15);
    assert.equal(dayKeyFromDate(parseDayKey(dayKeyFromDate(date))), dayKeyFromDate(date));
  });
});

describe('calendar droppable ids', () => {
  it('prefixes day keys and parses them back', () => {
    const key = '2026-07-07';
    assert.equal(calendarDayDroppableId(key), 'day:2026-07-07');
    assert.equal(parseCalendarDayDroppableId('day:2026-07-07'), key);
    assert.equal(parseCalendarDayDroppableId('mission-123'), null);
  });
});

describe('calendarWindowRange', () => {
  it('spans whole months around the anchor', () => {
    const anchor = new Date(2026, 6, 15);
    const { start, end } = calendarWindowRange({
      anchor,
      monthsBefore: 1,
      monthsAfter: 2
    });

    assert.equal(start.getTime(), startOfMonth(addMonths(anchor, -1)).getTime());
    assert.equal(end.getTime(), endOfMonth(addMonths(anchor, 2)).getTime());
  });
});

describe('eachMonthInRange', () => {
  it('returns inclusive month starts', () => {
    const start = new Date(2026, 0, 1);
    const end = new Date(2026, 2, 31);
    const months = eachMonthInRange({ start, end });

    assert.deepEqual(
      months.map(month => month.getMonth()),
      [0, 1, 2]
    );
  });
});

describe('getWeeksForMonth', () => {
  it('pads leading and trailing days to full Sunday-start weeks', () => {
    const weeks = getWeeksForMonth(new Date(2026, 2, 1));
    assert.equal(
      weeks.every(week => week.length === 7),
      true
    );
    assert.equal(weekdayIndex(weeks[0][0]), 0);
    assert.ok(weeks.length >= 4);
  });
});

describe('groupMissionsByDay', () => {
  it('buckets missions by local due date and ignores undated missions', () => {
    const targetDay = new Date(2026, 2, 4, 12, 0, 0);
    const dueDatetime = targetDay.toISOString();
    const grouped = groupMissionsByDay([
      mission({ id: 'a', dueDatetime }),
      mission({ id: 'b', dueDatetime: null }),
      mission({ id: 'c', dueDatetime })
    ]);

    const bucket = grouped.get(dayKeyFromDate(targetDay));
    assert.ok(bucket);
    assert.deepEqual(
      bucket.map(entry => entry.id),
      ['a', 'c']
    );
    assert.equal(grouped.size, 1);
  });

  it('sorts by boardPosition then descending sequenceNumber', () => {
    const targetDay = new Date(2026, 2, 4, 12, 0, 0);
    const dueDatetime = targetDay.toISOString();
    const grouped = groupMissionsByDay([
      mission({
        id: 'later-board',
        dueDatetime,
        boardPosition: 2,
        sequenceNumber: 1
      }),
      mission({
        id: 'earlier-board',
        dueDatetime,
        boardPosition: 1,
        sequenceNumber: 99
      }),
      mission({
        id: 'same-board-higher-seq',
        dueDatetime,
        boardPosition: 1,
        sequenceNumber: 50
      })
    ]);

    const day = grouped.get(dayKeyFromDate(targetDay));
    assert.ok(day);
    assert.deepEqual(
      day.map(entry => entry.id),
      ['earlier-board', 'same-board-higher-seq', 'later-board']
    );
  });
});

describe('date helpers', () => {
  it('addDays and addMonths preserve local calendar intent', () => {
    const base = new Date(2026, 0, 15);
    assert.equal(addDays(startOfDay(base), 1).getDate(), 16);
    assert.equal(addMonths(base, 1).getMonth(), 1);
  });
});
