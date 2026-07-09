import type { PeriodType, WeekDayType } from '@overlord/automations/scheduling-engine';

import type { ScheduleInput } from '../../../shared/contract.ts';

import { getDefaultSchedule } from './schedule-utils.ts';

export type ScheduleEditorInitialSchedule = {
  daysOfMonth?: number[];
  daysOfWeek: WeekDayType[];
  nextStatusId?: string | null;
  periodInterval: number;
  periodType: PeriodType;
  timezone: string;
  weeksOfMonth?: number[];
};

export type ScheduleState = {
  periodType: PeriodType;
  periodInterval: number;
  daysOfWeek: WeekDayType[];
  daysOfMonth?: number[];
  weeksOfMonth?: number[];
  timezone: string;
  time: string;
  monthlyMode: 'dayOfMonth' | 'weekOfMonth';
  nextStatusId: string | null;
};

export const LAST_DAY_OF_MONTH = 32;
export const LAST_WEEK_OF_MONTH = 5;

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function normalizeDaysOfMonth(daysOfMonth?: number[] | null): number[] {
  return uniqueSorted(
    (daysOfMonth ?? [])
      .map(day => (day >= 29 && day <= 31 ? LAST_DAY_OF_MONTH : day))
      .filter(day => (day >= 1 && day <= 28) || day === LAST_DAY_OF_MONTH)
  );
}

export function normalizeWeeksOfMonth(weeksOfMonth?: number[] | null): number[] {
  return uniqueSorted(
    (weeksOfMonth ?? [])
      .map(week => (week >= 4 && week <= 5 ? LAST_WEEK_OF_MONTH : week))
      .filter(week => (week >= 1 && week <= 3) || week === LAST_WEEK_OF_MONTH)
  );
}

export function extractTimeFromDaysOfWeek(daysOfWeek: WeekDayType[]): string {
  for (const day of daysOfWeek) {
    if (day.times?.length > 0) return day.times[0];
  }
  return '09:00';
}

export function createStateFromInitialSchedule(
  initialSchedule: ScheduleEditorInitialSchedule
): ScheduleState {
  const daysOfWeek = initialSchedule.daysOfWeek ?? [];
  const daysOfMonth = normalizeDaysOfMonth(initialSchedule.daysOfMonth);
  const weeksOfMonth = normalizeWeeksOfMonth(initialSchedule.weeksOfMonth);

  return {
    periodType: initialSchedule.periodType,
    periodInterval: initialSchedule.periodInterval,
    daysOfWeek,
    daysOfMonth: daysOfMonth.length > 0 ? daysOfMonth : undefined,
    weeksOfMonth: weeksOfMonth.length > 0 ? weeksOfMonth : undefined,
    timezone: initialSchedule.timezone,
    time: extractTimeFromDaysOfWeek(daysOfWeek),
    monthlyMode: weeksOfMonth.length > 0 ? 'weekOfMonth' : 'dayOfMonth',
    nextStatusId: initialSchedule.nextStatusId ?? null
  };
}

export function createDefaultState(): ScheduleState {
  const defaults = getDefaultSchedule();

  return {
    periodType: defaults.periodType,
    periodInterval: defaults.periodInterval,
    daysOfWeek: defaults.daysOfWeek,
    daysOfMonth: undefined,
    weeksOfMonth: undefined,
    timezone: defaults.timezone,
    time: '09:00',
    monthlyMode: 'dayOfMonth',
    nextStatusId: null
  };
}

export function stateToInput(state: ScheduleState): ScheduleInput {
  const input: ScheduleInput = {
    periodType: state.periodType,
    periodInterval: state.periodInterval,
    timezone: state.timezone,
    nextStatusId: state.nextStatusId
  };

  if (state.periodType === 'd') {
    input.daysOfWeek = [{ dayNum: 1, times: [state.time || '09:00'] }];
  } else if (state.periodType === 'w') {
    input.daysOfWeek = state.daysOfWeek.map(d => ({
      dayNum: d.dayNum,
      times: [state.time || '09:00']
    }));
  } else if (state.periodType === 'm') {
    if (state.monthlyMode === 'dayOfMonth') {
      input.daysOfMonth = normalizeDaysOfMonth(state.daysOfMonth);
    } else {
      input.weeksOfMonth = normalizeWeeksOfMonth(state.weeksOfMonth);
      input.daysOfWeek = state.daysOfWeek.map(d => ({
        dayNum: d.dayNum,
        times: [state.time || '09:00']
      }));
    }
  }

  return input;
}

export function getValidationMessage(state: ScheduleState): string | null {
  if (state.periodType === 'd') {
    return null;
  }
  if (state.periodType === 'w') {
    return state.daysOfWeek.length > 0 ? null : 'Choose at least one weekday for this schedule.';
  }
  if (state.periodType === 'm') {
    if (state.monthlyMode === 'dayOfMonth') {
      return (state.daysOfMonth?.length ?? 0) > 0
        ? null
        : 'Choose at least one day of the month for this schedule.';
    }
    if ((state.weeksOfMonth?.length ?? 0) === 0 && state.daysOfWeek.length === 0) {
      return 'Choose a week of the month and at least one weekday for this schedule.';
    }
    if ((state.weeksOfMonth?.length ?? 0) === 0) {
      return 'Choose a week of the month for this schedule.';
    }
    return state.daysOfWeek.length > 0
      ? null
      : 'Choose at least one weekday for this monthly schedule.';
  }
  return 'Choose a valid schedule type.';
}
