import type { ScheduleLike } from './helpers/types.ts';
import { genDateFromFailureRepeatSeconds, generateDate } from './schedulingEngineFunctions.ts';

export type {
  DayNumber,
  NormalizedSchedule,
  PeriodType,
  ScheduleLike,
  WeekDayType
} from './helpers/types.ts';

export const generateDateFromSchedule = ({
  schedule,
  itemDueDatetime
}: {
  schedule: ScheduleLike;
  itemDueDatetime?: Date | null;
}) => {
  return generateDate(itemDueDatetime === undefined ? { schedule } : { schedule, itemDueDatetime });
};

export const generateDateFromFailureRepeatSeconds = (failureRepeatSeconds: number): Date => {
  return genDateFromFailureRepeatSeconds(failureRepeatSeconds);
};
