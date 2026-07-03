# Mission Scheduling Engine — Implementation Plan

Mission: coo:124 — Implement Scheduling Engine for Mission Planning
Status: draft for review (Objective 1 = this plan; Objective 2 = the editor components)

## 1. Goal

Let a mission carry a **repeating schedule** and a computed **due date**. When a
scheduled mission reaches a `complete`-type status, the app spawns a duplicate
mission with the next computed due date, so recurring work (weekly reviews,
monthly reports, daily standups) regenerates itself. This mirrors the existing
ticket-scheduling behavior in the source project, ported onto Overlord's mission
model and dual-backend architecture.

## 2. What was ported, and what is broken

`automations/src/scheduling-engine/` contains the pure recurrence logic and is
sound on its own:

- `index.ts` — public API: `generateDateFromSchedule({ schedule, itemDueDatetime? })`
  and `generateDateFromFailureRepeatSeconds(seconds)`.
- `schedulingEngineFunctions.ts` — daily / weekly / monthly-by-day /
  monthly-by-week recurrence, all timezone-correct via `Intl.DateTimeFormat`.
- `helpers/types.ts`, `helpers/sortTimes.ts`, `schedulingEngine.test.ts`.

**Blocking problems to resolve before anything else:**

1. **Dangling dependency.** `schedulingEngineFunctions.ts:1` imports
   `scheduleInputSchema` from `@/lib/schemas/schedule` — a Next.js path alias
   from the *source* project that does not exist here. The engine will not
   compile until this is replaced.
2. **No zod in this repo.** `grep` finds zero `zod` usage or dependency across
   the workspace; validation everywhere is hand-rolled (`throw new ApiError /
   ServiceError`). So we can't just "add the missing schema" — we choose a
   validation strategy (§4).
3. **Not exported.** `automations/src/index.ts` does not re-export the engine, so
   nothing outside the folder can import it. The source `.md` also references
   Supabase migrations and `lib/actions/*` server actions that do not exist in
   this repo — treat the `.md` as *conceptual* documentation only.

## 3. Architecture mapping (source → this repo)

| Source project (Supabase / Next.js) | This repo (Overlord monorepo) |
|---|---|
| `public.schedule` table | new `schedules` table in `database/{sqlite,postgres}/migrations` |
| `tickets.schedule_id`, `tickets.due_datetime` | new `missions.schedule_id`, `missions.due_datetime` |
| `lib/actions/ticket-schedules.ts` (server actions) | REST handlers in `backend/repository.ts` **and** service fns in `packages/core/service/` (dual data layer) |
| `ticket_events` system event | mission change-feed entry via `recordChange(...)` |
| ticket → complete → duplicate | mission → `complete` status → duplicate (`patchMissionFieldsTx` + `reorderBoardColumn`) |
| zod `scheduleInputSchema` | hand-rolled normalizer/validator (§4) |
| Next.js server components UI | React + TanStack Query webapp (`webapp/web`) |

**Critical constraint (from CLAUDE.md + memory):** any schema change must land in
**all four places at once** — SQLite migration, Postgres migration, the
`backend/repository.ts` REST layer, and the `packages/core/service/*` protocol/CLI
layer — plus the contract DTOs in `webapp/shared/contract.ts`. Both data layers
hit the same tables; a change to one only is a latent bug. See CONTRACT.md.

## 4. Schedule validation — zod (DECIDED)

The engine calls `scheduleInputSchema.safeParse(...)` inside `normalizeSchedule`.
**Decision: use zod.** zod is already present in the tree (v4.4.1, pulled in
transitively by better-auth `^4.3.6`, shadcn, serwist) and the repo ships a
`zod-v4-patterns` skill enforcing v4 conventions, so it is the sanctioned choice
for new validation code. Restoring the engine's original zod schema also avoids
behavioral drift from a hand-ported validator.

Implementation notes:

- **Pin zod as a *direct* dependency of `@overlord/automations`.** Do not rely on
  the transitive hoist from better-auth — that would be a phantom dependency that
  breaks when better-auth bumps/drops zod, and it must be a declared dep for the
  CLI pack step (`vendor-database.mjs`) to bundle it. Match the already-resolved
  major (zod v4) and follow the `zod-v4-patterns` skill.
- Recreate `scheduleInputSchema` in-repo at
  `automations/src/scheduling-engine/helpers/scheduleSchema.ts` (replacing the
  dangling `@/lib/schemas/schedule` import), enforcing the rules in
  `schedulingEngine.md` §Validation (periodType ∈ d/w/m, periodInterval ≥ 1
  integer, valid `Intl` timezone, daily/weekly require `daysOfWeek`, monthly
  requires `daysOfMonth` **or** `weeksOfMonth`+`daysOfWeek`, `HH:mm[:ss]` times,
  `daysOfMonth` may include `32`).
- **Scope zod to the engine schema only.** The new schedule REST/service endpoints
  validate at their boundary in the existing hand-rolled `ApiError`/`ServiceError`
  style to match `repository.ts`; they delegate the deep schedule-shape check to
  the engine's zod schema rather than spreading zod across the service layer. The
  recurrence math stays pure behind the `normalizeSchedule` boundary.

## 5. Data model changes

### 5.1 `schedules` table (new) — SQLite + Postgres

Mirror the source `schedule` shape, adapted to this repo's conventions (TEXT ids,
`workspace_id` scoping like every other table, ISO-8601 CHECK'd timestamps):

- `id TEXT PRIMARY KEY`
- `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`
- `name TEXT`
- `period_type TEXT NOT NULL DEFAULT 'd' CHECK (period_type IN ('d','w','m'))`
- `period_interval INTEGER NOT NULL DEFAULT 1 CHECK (period_interval >= 1)`
- `weeks_of_month` / `days_of_month` — JSON arrays (`*_json TEXT ... CHECK(json_valid)`) to match this repo's SQLite-array convention (no native arrays in SQLite)
- `days_of_week_json TEXT` — JSON `[{dayNum, times[]}]`
- `start_date TEXT` (nullable, ISO-8601)
- `timezone TEXT NOT NULL` — defaulted from the browser at creation time (§10, Q3)
- `next_status_id TEXT` — **configurable duplicate target status** (Q2).
  Nullable, org-scoped composite FK `(workspace_id, next_status_id) →
  workspace_statuses(workspace_id, id)`. When set, the regenerated duplicate lands
  in this status/column; when `NULL`, fall back to the workspace default/next-up
  status (source behavior). Storing it on the schedule (rather than the mission)
  means the choice carries forward across every regeneration.
- `created_at` / `updated_at` (ISO-8601, CHECK'd like `missions`)
- unique index on `(workspace_id, id)` for org-scoped FK

Postgres variant uses `smallint[]` / `jsonb` and real timestamptz per the
existing Postgres migration conventions, and adds the schema-level CHECKs the
source `.md` lists (bounded days/weeks, valid `days_of_week` JSON shape).

### 5.2 `missions` columns (new)

Add to the `missions` table (both dialects):

- `schedule_id TEXT REFERENCES schedules(id)` — org-scoped composite FK
  `(workspace_id, schedule_id) → schedules(workspace_id, id)`
- `due_datetime TEXT` (ISO-8601, CHECK'd, nullable)

Note: `missions` already has `metadata_json`, but per the memory note
("prefer a dedicated column for per-item state") these are dedicated columns, not
metadata keys — they're queried/sorted and drive the duplication trigger.

### 5.3 Row types + `toMissionDto`

- Extend `MissionRow` (`backend/repository.ts:367`) and the service row selects
  with `schedule_id` / `due_datetime`.
- Extend `toMissionDto` (`backend/repository.ts:649`) to surface
  `scheduleId` / `dueDatetime` on `MissionDto`.

## 6. Engine wiring

1. Replace the dangling zod import in `schedulingEngineFunctions.ts` with the
   §4 hand-rolled `normalizeScheduleInput`.
2. Re-export the engine from `automations/src/index.ts`:
   `generateDateFromSchedule`, `generateDateFromFailureRepeatSeconds`, and the
   `ScheduleLike` / `NormalizedSchedule` / `PeriodType` / `WeekDayType` types.
3. Update `schedulingEngine.md` to drop the stale Supabase/`lib/actions`
   references and describe the mission wiring instead.
4. Keep `schedulingEngine.test.ts` green; add a normalizer unit test since the
   validation path moves in-repo.

## 7. Service + REST layer (the "server actions" equivalent)

Implement in **both** `packages/core/service/` (new `mission-schedules.ts`) and
`backend/repository.ts`, sharing the engine. Functions map 1:1 to the source
actions:

- `previewScheduleDueDatetime(input, itemDueDatetime?)` — validate + compute,
  no write. Powers the ScheduleEditor live preview.
- `getMissionSchedule(missionId)` — load mission + linked schedule; return
  `{ dueDatetime, schedule }`.
- `upsertMissionSchedule(missionId, input)` — validate, create/update the
  `schedules` row, compute `due_datetime`, set `missions.schedule_id` +
  `due_datetime`, record a change-feed entry. Run inside one
  `client.transaction` — **pass `tx` to every helper** (SqliteClient tx-mutex
  deadlock, see memory).
- `clearMissionSchedule(missionId)` — null out `schedule_id` + `due_datetime`;
  delete the `schedules` row only if no other mission references it.
- `getNextScheduledDueDatetime(missionId)` — compute-only, no persist.

REST surface (new routes, wired in the webapp router + `webapp/web/lib/api.ts`):
`GET/PUT/DELETE /api/missions/:id/schedule` and
`POST /api/missions/schedule/preview`.

## 8. Recurrence trigger — mission completion

The source duplicates a ticket when it enters a `complete` status. Missions have
the identical `status_type` enum (`draft|execute|review|complete|blocked|
cancelled`, `missions` table def). There are **two** places a mission's
`status_type` becomes `complete`, and both must call the new hook:

1. `patchMissionFieldsTx` (`backend/repository.ts:3073`) — direct status set via
   PATCH / MissionStatusSelect.
2. `reorderBoardColumn` (`backend/repository.ts:3322`) — drag onto a complete
   column.

Add `createScheduledDuplicateIfNeeded(tx, mission, newStatusType)`:

1. no-op unless `newStatusType === 'complete'` **and** `mission.schedule_id`.
2. **Skip when the target is `cancelled`** — source-critical exception
   (`cancelled` is also complete-type here, same as source).
3. load the schedule, `generateDateFromSchedule({ schedule, itemDueDatetime:
   mission.due_datetime })` for the next due date.
4. pick the duplicate's status: use the schedule's `next_status_id` when set
   (Q2), else fall back to the workspace's `draft`/next-up default (reuse
   `getDefaultStatusId`). Validate the configured status still exists and belongs
   to the workspace; if it was deleted, fall back to the default. Place at end of
   the chosen column via `topBoardPosition`.
5. duplicate carry-forward fields (title, project, tags, tools, acceptance
   criteria, constraints, objectives' instruction text, `schedule_id`) and set
   the new `due_datetime`; mint a fresh `display_id`/`sequence_number` the same
   way `createMissionWithObjectives` does.
6. record change-feed entries on both source and duplicate.

Reuse the existing objective-duplication logic from
`createMissionWithObjectives` (`packages/core/service/missions.ts:433`) rather
than re-implementing.

## 9. Contract DTO changes (CONTRACT.md impact)

- `MissionDto`: add `scheduleId: string | null`, `dueDatetime: string | null`.
- New `ScheduleDto` (period fields, arrays, timezone, startDate, name) and
  `ScheduleInput` request DTO; `MissionScheduleDto = { dueDatetime, schedule }`.
- New route contracts for the schedule endpoints (§7).
- Regenerate `webapp/shared/contract.d.ts`.

Contract change is additive (new nullable fields + new endpoints), so impact on
other modules is low, but it must be recorded in CONTRACT.md and both data layers
updated in lockstep per the component contract.

## 10. Webapp UI — Objective 2 (`DueDateEditor` + `ScheduleEditor`)

Port the two components referenced in Objective 2 into
`webapp/web/components/features/scheduling/` and mount them in `MissionPanel.tsx`
(likely a new "Schedule" row in `MissionSettingsBar` or the supporting section):

- **`DueDateEditor`** — view/edit `mission.dueDatetime`; simple date/time picker.
- **`ScheduleEditor`** — build a `ScheduleInput` (period type, interval,
  weekdays/times, days-of-month, weeks-of-month, timezone, start date) and call
  the **preview** endpoint (which runs the SchedulingEngine) to show the computed
  next due date live before saving. This is the "connected to the
  SchedulingEngine" requirement — the connection is via the preview/upsert
  endpoints that invoke `generateDateFromSchedule`. Two decided behaviors:
  - **Timezone defaults from the browser** (Q3):
    `Intl.DateTimeFormat().resolvedOptions().timeZone` prefills the field on a new
    schedule (user can still override); the resolved value is persisted on the
    `schedules` row so recurrence is stable regardless of who edits later.
  - **Target-status picker** (Q2): a workspace-status select bound to
    `next_status_id` that sets which column the regenerated duplicate lands in,
    defaulting to "workspace default / next-up" when left unset.

Add TanStack Query hooks in `webapp/web/lib/queries.ts`
(`useMissionSchedule`, `useUpsertMissionSchedule`, `useClearMissionSchedule`,
`usePreviewScheduleDueDatetime`) + `api.ts` methods, invalidating the mission
query on mutation. The source components live in the private Overlord repo; port
by adapting to this repo's UI primitives (`components/ui/*`) and query patterns.

Detailed component work is tracked under Objective 2 and executed after the
data/engine layers (§5–§9) land.

## 11. Migrations, testing, sequencing

**Sequencing (safe to land incrementally):**

1. Fix engine import + normalizer + export from automations (+ tests). *No
   schema change — mergeable alone.*
2. Migrations (SQLite + Postgres) for `schedules` + `missions` columns.
3. Service layer (`mission-schedules.ts`) + repository REST + contract DTOs.
4. Completion trigger wiring in both status-change paths.
5. Webapp hooks + UI components (Objective 2).

**Testing:**
- keep `schedulingEngine.test.ts` green; add normalizer unit tests.
- service tests (follow `packages/core/service/missions.*.test.ts` and
  `postgres-conformance.test.ts`) for upsert/clear/preview + the duplication
  trigger, incl. the `cancelled` skip and the DST edge the source `.md` flags.
- run under the pod's better-sqlite3 redirect harness (see memory) since native
  modules differ cross-platform.

## 12. Decisions (resolved with PM) + remaining question

Resolved:

1. **Validation approach → zod.** Adopt zod, pinned as a direct dependency of
   `@overlord/automations`, scoped to the engine schema. (§4)
2. **Duplicate's target status → configurable per schedule.** Stored as
   `schedules.next_status_id`, with a ScheduleEditor picker; falls back to the
   workspace default/next-up when unset. (§5.1, §8, §10)
3. **Timezone → inferred from the browser** and persisted on the schedule. (§10)

Remaining:

4. **Scope of Objective 1** — this deliverable is the *plan*. Confirm before I
   start implementing §5–§9 (or should I proceed straight into step 1, the engine
   import fix + zod schema + export, since it's low-risk and unblocks everything?).
