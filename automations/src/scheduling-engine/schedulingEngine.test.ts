import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { scheduleInputSchema } from './helpers/scheduleSchema.ts';
import { generateDateFromFailureRepeatSeconds, generateDateFromSchedule } from './index.ts';

describe('generateDateFromSchedule', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('returns the next daily occurrence on the same local day when a later time exists', () => {
    mock.timers.setTime(new Date('2026-03-25T09:00:00.000Z').getTime());

    const result = generateDateFromSchedule({
      schedule: {
        periodType: 'd',
        periodInterval: 1,
        timezone: 'UTC',
        daysOfWeek: [{ dayNum: 1, times: ['08:00:00', '11:30:00'] }]
      }
    });

    assert.equal(result.toISOString(), '2026-03-25T11:30:00.000Z');
  });

  it('normalizes legacy day_num payloads and honors weekly intervals', () => {
    mock.timers.setTime(new Date('2026-03-25T12:00:00.000Z').getTime());

    const result = generateDateFromSchedule({
      schedule: {
        periodType: 'w',
        periodInterval: 2,
        timezone: 'UTC',
        startDate: '2026-03-23T10:00:00.000Z',
        daysOfWeek: [{ day_num: 1, times: ['10:00:00'] }]
      }
    });

    assert.equal(result.toISOString(), '2026-04-06T10:00:00.000Z');
  });

  it('uses the provided due datetime as the recurrence anchor instead of drifting to now', () => {
    mock.timers.setTime(new Date('2026-03-25T16:00:00.000Z').getTime());

    const result = generateDateFromSchedule({
      schedule: {
        periodType: 'd',
        periodInterval: 1,
        timezone: 'UTC',
        daysOfWeek: [{ dayNum: 1, times: ['09:00:00'] }]
      },
      itemDueDatetime: new Date('2026-03-24T09:00:00.000Z')
    });

    assert.equal(result.toISOString(), '2026-03-25T09:00:00.000Z');
  });

  it('supports last-day monthly rules without mutating the configured array', () => {
    mock.timers.setTime(new Date('2026-02-20T08:00:00.000Z').getTime());

    const daysOfMonth = [32, 15];
    const result = generateDateFromSchedule({
      schedule: {
        periodType: 'm',
        periodInterval: 1,
        timezone: 'UTC',
        daysOfMonth,
        daysOfWeek: [{ dayNum: 0, times: ['23:59:00'] }]
      }
    });

    assert.equal(result.toISOString(), '2026-02-28T23:59:00.000Z');
    assert.deepEqual(daysOfMonth, [32, 15]);
  });

  it('supports monthly week-based rules', () => {
    mock.timers.setTime(new Date('2026-03-01T00:00:00.000Z').getTime());

    const result = generateDateFromSchedule({
      schedule: {
        periodType: 'm',
        periodInterval: 1,
        timezone: 'UTC',
        weeksOfMonth: [2],
        daysOfWeek: [{ dayNum: 3, times: ['14:00:00'] }]
      }
    });

    assert.equal(result.toISOString(), '2026-03-11T14:00:00.000Z');
  });

  it('throws a validation error for invalid timezones', () => {
    assert.throws(
      () =>
        generateDateFromSchedule({
          schedule: {
            periodType: 'd',
            periodInterval: 1,
            timezone: 'Mars/Base',
            daysOfWeek: [{ dayNum: 1, times: ['09:00:00'] }]
          }
        }),
      /Timezone is invalid\./
    );
  });
});

describe('generateDateFromFailureRepeatSeconds', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('adds retry seconds to the current time', () => {
    mock.timers.setTime(new Date('2026-03-25T10:00:00.000Z').getTime());

    assert.equal(
      generateDateFromFailureRepeatSeconds(90).toISOString(),
      '2026-03-25T10:01:30.000Z'
    );
  });
});

describe('scheduleInputSchema', () => {
  it('rejects daily schedules missing daysOfWeek', () => {
    const parsed = scheduleInputSchema.safeParse({
      periodType: 'd',
      periodInterval: 1,
      timezone: 'UTC'
    });

    assert.equal(parsed.success, false);
  });

  it('rejects monthly schedules missing both daysOfMonth and weeksOfMonth/daysOfWeek', () => {
    const parsed = scheduleInputSchema.safeParse({
      periodType: 'm',
      periodInterval: 1,
      timezone: 'UTC'
    });

    assert.equal(parsed.success, false);
  });

  it('accepts a monthly schedule using weeksOfMonth + daysOfWeek', () => {
    const parsed = scheduleInputSchema.safeParse({
      periodType: 'm',
      periodInterval: 1,
      timezone: 'UTC',
      weeksOfMonth: [1],
      daysOfWeek: [{ dayNum: 1, times: ['09:00'] }]
    });

    assert.equal(parsed.success, true);
  });

  it('rejects malformed time strings', () => {
    const parsed = scheduleInputSchema.safeParse({
      periodType: 'w',
      periodInterval: 1,
      timezone: 'UTC',
      daysOfWeek: [{ dayNum: 1, times: ['9:00'] }]
    });

    assert.equal(parsed.success, false);
  });

  it('accepts daysOfMonth including 32 for last-day-of-month', () => {
    const parsed = scheduleInputSchema.safeParse({
      periodType: 'm',
      periodInterval: 1,
      timezone: 'UTC',
      daysOfMonth: [32],
      daysOfWeek: [{ dayNum: 0, times: ['23:59'] }]
    });

    assert.equal(parsed.success, true);
  });
});
