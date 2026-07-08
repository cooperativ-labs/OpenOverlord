import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDueDatetime,
  fromDateInputValue,
  parseDueDate,
  toDateInputValue
} from './due-datetime.ts';

describe('parseDueDate', () => {
  it('returns undefined for empty or invalid values', () => {
    assert.equal(parseDueDate(null), undefined);
    assert.equal(parseDueDate(''), undefined);
    assert.equal(parseDueDate('not-a-date'), undefined);
  });

  it('parses ISO strings', () => {
    const parsed = parseDueDate('2026-03-04T15:30:00.000Z');
    assert.ok(parsed);
    assert.equal(parsed.toISOString(), '2026-03-04T15:30:00.000Z');
  });
});

describe('date input helpers', () => {
  it('round-trips local dates through input values', () => {
    const date = new Date(2026, 6, 7);
    assert.equal(toDateInputValue(date), '2026-07-07');
    assert.equal(fromDateInputValue('2026-07-07').getDate(), 7);
  });
});

describe('buildDueDatetime', () => {
  it('preserves UTC time when moving an existing due date', () => {
    const selectedDate = new Date(2026, 6, 15);
    const currentDueDatetime = '2026-03-04T09:45:30.000Z';

    const next = buildDueDatetime({ selectedDate, currentDueDatetime });
    const parsed = new Date(next);

    assert.equal(parsed.getUTCFullYear(), 2026);
    assert.equal(parsed.getUTCMonth(), 6);
    assert.equal(parsed.getUTCDate(), 15);
    assert.equal(parsed.getUTCHours(), 9);
    assert.equal(parsed.getUTCMinutes(), 45);
    assert.equal(parsed.getUTCSeconds(), 30);
  });

  it('defaults new due dates to noon UTC on the selected day', () => {
    const selectedDate = new Date(2026, 2, 10);
    const next = buildDueDatetime({ selectedDate, currentDueDatetime: null });

    assert.equal(next, '2026-03-10T12:00:00.000Z');
  });
});
