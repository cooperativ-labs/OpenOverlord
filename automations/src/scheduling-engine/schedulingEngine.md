# Scheduling Engine

## Purpose

This folder contains the recurrence logic used by Overlord mission scheduling.

Missions can carry a repeating schedule:

- a mission can store a `schedule_id`
- a mission can store a computed `due_datetime`
- when a scheduled mission is moved into a `complete`-type status, the app creates
  a duplicate mission and computes its next `due_datetime`

The scheduling engine is pure application logic. It does not update the database
directly. Database writes happen in `packages/core/service/mission-schedules.ts`
and the equivalent REST handlers in `backend/repository.ts` (this repo's dual
data layer — see `CONTRACT.md`). See
`planning/feature-plans/mission-scheduling-engine.md` for the full mapping of
this engine onto the mission model.

## Files

- [`index.ts`](./index.ts)
  Thin public entrypoint for the engine.
- [`schedulingEngineFunctions.ts`](./schedulingEngineFunctions.ts)
  The recurrence implementation.
- [`helpers/types.ts`](./helpers/types.ts)
  Local schedule and weekday types.
- [`helpers/sortTimes.ts`](./helpers/sortTimes.ts)
  Stable non-mutating sort for schedule times.
- [`schedulingEngine.test.ts`](./schedulingEngine.test.ts)
  Focused behavior tests for daily, weekly, monthly, and validation paths.

## Public API

### `generateDateFromSchedule({ schedule, itemDueDatetime? })`

Defined in [`index.ts`](./index.ts).

Inputs:

- `schedule`
  A local `ScheduleLike` object.
- `itemDueDatetime?`
  Optional reference datetime. When present, this is typically the current ticket due datetime and is used as the recurrence anchor when generating the next scheduled ticket.

Output:

- a `Date` representing the next scheduled occurrence in UTC

### `generateDateFromFailureRepeatSeconds(failureRepeatSeconds)`

Defined in [`index.ts`](./index.ts).

Output:

- `new Date(now + failureRepeatSeconds)`

This helper is not tied to ticket schedules. It is just a small retry-delay utility.

## Schedule Shape

The engine normalizes schedule input through
[`scheduleInputSchema`](./helpers/scheduleSchema.ts), a zod schema local to this
folder (pinned as a direct `zod` dependency of `@overlord/automations`).

The normalized conceptual shape is:

```ts
type WeekDayType = {
  dayNum: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  times: string[];
};

type NormalizedSchedule = {
  name: string | null;
  periodType: 'd' | 'w' | 'm';
  periodInterval: number;
  weeksOfMonth: number[];
  daysOfMonth: number[];
  daysOfWeek: WeekDayType[];
  timezone: string;
  startDate: Date | null;
};
```

Important details:

- `times` must be `HH:mm` or `HH:mm:ss`
- `daysOfMonth` may include `32`, which means "last day of month"
- the engine accepts both `dayNum` and legacy `day_num` on input
- `startDate` is optional, but when present it becomes the primary recurrence anchor

## Validation Rules

Validation happens before scheduling math runs.

Current rules:

- `periodType` must be `d`, `w`, or `m`
- `periodInterval` must be an integer `>= 1`
- `timezone` must be valid for `Intl.DateTimeFormat`
- daily schedules require `daysOfWeek`
- weekly schedules require `daysOfWeek`
- monthly schedules require either:
  - `daysOfMonth`, or
  - both `weeksOfMonth` and `daysOfWeek`

The `schedules` table migration (SQLite + Postgres, see
`planning/feature-plans/mission-scheduling-engine.md` §5.1) also adds
schema-level checks for:

- valid `period_type`
- positive `period_interval`
- bounded `days_of_month`
- bounded `weeks_of_month`
- a valid `days_of_week` JSON shape

## Database Model

The scheduling model in this repo:

### `schedules` (SQLite + Postgres)

- `id`, `workspace_id` (org-scoped, like every other table)
- `period_type`, `period_interval`
- `weeks_of_month`, `days_of_month` (JSON arrays in SQLite, native arrays in Postgres)
- `days_of_week` (JSON `[{dayNum, times[]}]`)
- `start_date`, `timezone`, `name`
- `next_status_id` — configurable duplicate target status; org-scoped FK to
  `workspace_statuses`, falls back to the workspace default/next-up status when
  unset or deleted

### `missions`

Scheduling adds:

- `due_datetime` (ISO-8601, nullable)
- `schedule_id` (nullable, org-scoped FK to `schedules`)

## Service + REST Layer

The scheduling actions are implemented twice, sharing this engine — once in
`packages/core/service/mission-schedules.ts` (protocol/CLI data layer) and once
in `backend/repository.ts` (REST data layer), per this repo's dual-backend
architecture (`CONTRACT.md`).

### `previewScheduleDueDatetime(input, itemDueDatetime?)`

- validates the schedule
- computes the next due datetime
- does not write anything

### `getMissionSchedule(missionId)`

- loads the mission
- loads the linked schedule when one exists
- returns both the mission due datetime and the schedule payload

### `upsertMissionSchedule(missionId, input)`

- validates the schedule
- creates or updates the linked `schedules` row
- computes the next `due_datetime`
- updates the mission with `schedule_id` and `due_datetime`
- records a mission change-feed entry

### `clearMissionSchedule(missionId)`

- clears `missions.schedule_id`
- clears `missions.due_datetime`
- deletes the schedule row only if no other mission still references it
- records a mission change-feed entry

### `getNextScheduledDueDatetime(missionId)`

- loads the linked schedule and current due datetime
- computes the next due datetime without persisting it

## Mission Completion Flow

The scheduling side effect is triggered from mission status changes in
`backend/repository.ts` — both `patchMissionFieldsTx` (direct status set) and
`reorderBoardColumn` (drag onto a complete-type column) call the same hook.

`createScheduledDuplicateIfNeeded(...)` does this:

1. no-op unless the new status is `complete`-type and the mission has a `schedule_id`
2. load the linked schedule
3. compute the next due datetime with `generateDateFromSchedule(...)`
4. choose the next status for the duplicate
   - uses the schedule's configurable `next_status_id` when set and still valid
   - otherwise falls back to the workspace default/next-up status
5. duplicate the mission fields that should carry forward (title, project,
   tags, tools, acceptance criteria, constraints, `schedule_id`) and set the new
   `due_datetime`
6. copy the latest objective instruction text into the duplicate's draft objective
7. place the duplicate at the end of the chosen board column
8. record change-feed entries on both the source and duplicate mission

Important exception:

- `cancelled` is also a `complete`-type status in this app, but duplication is
  explicitly skipped when the new status is `cancelled`

## Engine Semantics

The engine always returns the next occurrence strictly after the chosen reference time.

### Reference time

The engine determines its search point like this:

1. choose a reference date:
   - `itemDueDatetime`, else
   - `schedule.startDate`, else
   - `new Date()`
2. add one second
3. search for the first valid occurrence after that timestamp

That `+1 second` rule is intentional. It prevents the engine from returning the exact same occurrence again when called with an existing due datetime.

### Timezone handling

The schedule is defined in local schedule time, not UTC.

The implementation:

- converts the current UTC date into local date parts for the schedule timezone
- performs recurrence math using those local date parts
- converts each candidate local datetime back into a UTC `Date`

This is why the engine uses `Intl.DateTimeFormat`-based local-part extraction rather than the old copied `date-fns-tz` wrapper.

## Recurrence Rules

### Daily

For `periodType === 'd'`:

- the engine uses `daysOfWeek[0].times`
- it searches forward day by day
- a day is eligible when it is `periodInterval` days from the recurrence anchor
- it returns the first candidate time greater than the search start

This means daily schedules treat the first weekday entry as the canonical time list.

### Weekly

For `periodType === 'w'`:

- `daysOfWeek` defines the allowed weekdays and times
- the engine searches forward day by day
- it computes the week start for both the anchor and each candidate day
- a candidate week is eligible when the number of weeks since the anchor is divisible by `periodInterval`

This fixes the copied implementation flaw where weekly schedules ignored `periodInterval`.

### Monthly by day of month

For `periodType === 'm'` with `daysOfMonth.length > 0`:

- the engine searches month by month
- only months aligned to `periodInterval` from the anchor are eligible
- candidate days are taken from `daysOfMonth`
- `32` is converted to the actual last day of that month
- times come from `daysOfWeek[0].times`

### Monthly by week-of-month

For `periodType === 'm'` with `weeksOfMonth` and `daysOfWeek`:

- the engine searches eligible months by `periodInterval`
- for each allowed weekday, it enumerates every occurrence of that weekday in the month
- each requested week number is mapped onto that occurrence list
- when the requested week number exceeds the number of occurrences, the engine uses the final occurrence

This supports rules like:

- first Monday
- second Wednesday
- last Friday-like behavior by using a week number that collapses to the final occurrence

## Differences From The Copied Source Notes

This repo no longer matches the original copied markdown assumptions.

Notable differences:

- there is no external `schedulingEngine.ts` wrapper anymore; the entrypoint is [`index.ts`](./index.ts)
- there is no `date-fns` or `date-fns-tz` injection layer in the current implementation
- the engine now validates input through Zod before running recurrence math
- the engine now uses `startDate`
- the engine now honors weekly `periodInterval`
- the engine now accepts legacy `day_num`
- the engine avoids mutating caller arrays when sorting times
- scheduling is wired to Overlord missions, not tickets from the source repo

## Current Limitations

These are the main limitations of the current implementation:

- daily and monthly-by-day schedules still use `daysOfWeek[0].times` as the canonical time source
- tests are focused and useful, but they are not exhaustive around DST edge cases
- the docs describe the current application behavior, but UX for editing schedules still belongs to a future ticket

## Test Coverage

[`schedulingEngine.test.ts`](./schedulingEngine.test.ts) currently covers:

- same-day daily recurrence
- weekly recurrence with `periodInterval > 1`
- using `itemDueDatetime` as the anchor
- monthly `32 => last day of month`
- monthly week-based scheduling
- invalid timezone rejection
- retry-delay helper behavior
