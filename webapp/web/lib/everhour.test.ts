import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatClock, formatHoursMinutes, parseDurationToSeconds } from './everhour.ts';

test('formatClock renders M:SS under an hour and H:MM:SS at/over an hour', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(5), '0:05');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3600), '1:00:00');
  assert.equal(formatClock(3661), '1:01:01');
  assert.equal(formatClock(-10), '0:00');
});

test('formatHoursMinutes renders compact human durations', () => {
  assert.equal(formatHoursMinutes(0), '0m');
  assert.equal(formatHoursMinutes(60), '1m');
  assert.equal(formatHoursMinutes(2700), '45m');
  assert.equal(formatHoursMinutes(3600), '1h');
  assert.equal(formatHoursMinutes(5400), '1h 30m');
  assert.equal(formatHoursMinutes(3660), '1h 1m');
});

test('parseDurationToSeconds accepts unit, clock, decimal, and bare-minute forms', () => {
  assert.equal(parseDurationToSeconds('1h 30m'), 5400);
  assert.equal(parseDurationToSeconds('1h'), 3600);
  assert.equal(parseDurationToSeconds('90m'), 5400);
  assert.equal(parseDurationToSeconds('1.5h'), 5400);
  assert.equal(parseDurationToSeconds('1:30'), 5400);
  assert.equal(parseDurationToSeconds('0:45'), 2700);
  assert.equal(parseDurationToSeconds('30'), 1800); // bare number = minutes
});

test('parseDurationToSeconds rejects empty, zero, and garbage input', () => {
  assert.equal(parseDurationToSeconds(''), null);
  assert.equal(parseDurationToSeconds('   '), null);
  assert.equal(parseDurationToSeconds('0'), null);
  assert.equal(parseDurationToSeconds('0h 0m'), null);
  assert.equal(parseDurationToSeconds('abc'), null);
  assert.equal(parseDurationToSeconds('1:99'), null); // minutes out of range
});
