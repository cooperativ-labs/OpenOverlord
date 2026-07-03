export type DayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type WeekDayType = {
  dayNum: DayNumber;
  times: string[];
};

export type PeriodType = 'd' | 'w' | 'm';

export type ScheduleLike = {
  daysOfMonth?: number[] | null;
  daysOfWeek?: Array<
    | WeekDayType
    | {
        day_num?: number | null;
        dayNum?: number | null;
        times?: string[] | null;
      }
  > | null;
  name?: string | null;
  periodInterval?: number | null;
  periodType?: string | null;
  startDate?: Date | string | null;
  start_date?: Date | string | null;
  timezone?: string | null;
  weeksOfMonth?: number[] | null;
};

export type NormalizedSchedule = {
  daysOfMonth: number[];
  daysOfWeek: WeekDayType[];
  name: string | null;
  periodInterval: number;
  periodType: PeriodType;
  startDate: Date | null;
  timezone: string;
  weeksOfMonth: number[];
};
