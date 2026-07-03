import { z } from 'zod';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const dayNumberSchema = z
  .number({ error: 'Day number must be between 0 and 6.' })
  .int()
  .min(0, { error: 'Day number must be between 0 and 6.' })
  .max(6, { error: 'Day number must be between 0 and 6.' });

const weekDaySchema = z.object({
  dayNum: dayNumberSchema,
  times: z
    .array(
      z
        .string({ error: 'Time is required.' })
        .regex(TIME_PATTERN, { error: 'Time must be in HH:mm or HH:mm:ss format.' })
    )
    .min(1, { error: 'At least one time is required per day.' })
});

export const scheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    periodType: z.enum(['d', 'w', 'm'], { error: 'Period type must be d, w, or m.' }),
    periodInterval: z
      .number({ error: 'Period interval is required.' })
      .int({ error: 'Period interval must be an integer.' })
      .min(1, { error: 'Period interval must be at least 1.' }),
    weeksOfMonth: z
      .array(
        z
          .number({ error: 'Week of month must be between 1 and 5.' })
          .int()
          .min(1, { error: 'Week of month must be between 1 and 5.' })
          .max(5, { error: 'Week of month must be between 1 and 5.' })
      )
      .optional(),
    daysOfMonth: z
      .array(
        z
          .number({ error: 'Day of month must be between 1 and 32.' })
          .int()
          .min(1, { error: 'Day of month must be between 1 and 32.' })
          .max(32, { error: 'Day of month must be between 1 and 32.' })
      )
      .optional(),
    daysOfWeek: z.array(weekDaySchema).optional(),
    timezone: z
      .string({ error: 'Timezone is required.' })
      .refine(isValidTimezone, { error: 'Timezone is invalid.' }),
    startDate: z.union([z.string(), z.date()]).optional()
  })
  .refine(
    data => {
      if (data.periodType === 'd' || data.periodType === 'w') {
        return !!data.daysOfWeek && data.daysOfWeek.length > 0;
      }

      return true;
    },
    { error: 'Daily and weekly schedules require daysOfWeek.', path: ['daysOfWeek'] }
  )
  .refine(
    data => {
      if (data.periodType !== 'm') {
        return true;
      }

      const hasDaysOfMonth = !!data.daysOfMonth && data.daysOfMonth.length > 0;
      const hasWeeksRule =
        !!data.weeksOfMonth &&
        data.weeksOfMonth.length > 0 &&
        !!data.daysOfWeek &&
        data.daysOfWeek.length > 0;

      return hasDaysOfMonth || hasWeeksRule;
    },
    {
      error: 'Monthly schedules require daysOfMonth or weeksOfMonth with daysOfWeek.',
      path: ['daysOfMonth']
    }
  );

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
