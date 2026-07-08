# Calendar View — Implementation Plan

Mission: coo:176 — Add calendar view
Status: draft for review (Objective 1 = this plan; Objective 2 = implementation)

## 1. Goal

Add a **Calendar** view alongside the existing **Board** and **List** views on the
project mission board. The calendar shows missions that have a due date, grouped by
day, with infinite vertical scroll and sticky month headers. Users can open a
mission from a card, mark it complete via checkbox, and drag cards between days to
change the due date.

The calendar must reuse the same mission data loading, filtering, and realtime
invalidation paths as Board and List — no new list endpoint or pagination API for
v1.

## 2. Scope

### In scope (v1)

- Project board (`BoardPage` at `/projects/$projectId`) gains a third view mode:
  `calendar`.
- `MissionCalendarCard` — simplified mission row styled with project color.
- `MissionCalendarView` — scrollable day grid with sticky month labels.
- Drag-and-drop between days updates `missions.due_datetime` via existing
  `PATCH /api/missions/:id` (`UpdateMissionBody.dueDatetime`).
- Shared filters (status, tags) from `BoardPage` apply to calendar the same way
  they apply to list view.
- Clicking a card navigates to `/projects/$projectId/missions/$missionId` (mission
  panel outlet), matching board/list behavior.
- Complete checkbox uses the same `handleCompleteMission` path as list view
  (`useSetMissionStatus` → workspace `complete` status).
- View preference persisted in `localStorage` via extended `readStoredBoardView` /
  `storeBoardView`.

### Out of scope (v1)

- **My Missions** (`/user`) calendar view — follow-up once project calendar is
  stable; would need multi-project color handling already present in
  `getMissionCardContext` on `MissionListView`.
- Server-side date-range queries or paginated mission fetches.
- Creating missions by clicking an empty day cell (nice follow-up).
- Missions **without** a due date on the calendar grid (see §5.3).
- Changing or clearing linked recurring schedules when dragging (drag only sets
  `dueDatetime`; schedule row is untouched, matching `DueDateEditor` override
  semantics documented on `UpdateMissionBody`).

## 3. Current architecture baseline

| Concern | Existing implementation | Calendar reuse |
| --- | --- | --- |
| Mission list | `useMissions(projectId)` → `GET /api/projects/:id/missions` | Same hook; client groups by date |
| Filters | `BoardPage` status/tag filters → `filteredMissions` | Pass filtered subset into calendar |
| Complete | `handleCompleteMission` + `MissionCompleteCheckbox` | Reuse primitives from `MissionCardPrimitives.tsx` |
| Open panel | `useNavigate` to mission route; `selectedMissionId` from `useMatch` | Same |
| Due date update | `useUpdateMission(id)` → `api.updateMission` with `dueDatetime` | New optimistic calendar DnD hook |
| Due date day math | `buildDueDatetime` in `DueDateEditor.tsx` (preserve time-of-day) | Extract to shared util |
| View toggle | `MissionsViewToggle` + `BoardView` in `board-shared.ts` | Extend type and toggle |
| DnD library | `@dnd-kit/core` (board/list status columns) | Separate calendar DnD (date droppables) |
| Realtime | SSE invalidates `keys.missions(projectId)` | No change |

**Contract impact:** None. Calendar is a web-only presentation layer over existing
REST fields (`dueDatetime` on `MissionDto`, `UpdateMissionBody.dueDatetime`). No
`CONTRACT.md` or `contract/*.yaml` updates required.

## 4. UX specification

### 4.1 Layout

```
[Board | List | Calendar]   [Status▾] [Tag▾]

        ┌─ March 2026 ───────────────────────────── (sticky)
        │  Mon 2        Tue 3        Wed 4   ...
        │  ┌─────────┐  ┌─────────┐
        │  │ □ Title │  │ □ Title │
        │  │ 1:1429  │  │ 1:1431  │
        │  └─────────┘  └─────────┘
        │
        ├─ April 2026 ───────────────────────────── (sticky)
        │  ...
```

- **Scroll axis:** vertical infinite scroll through consecutive calendar days.
- **Day column:** one column per weekday in a 7-column CSS grid (Mon–Sun or
  locale-aware Sun–Sat — pick one and document; recommend **week starting Monday**
  to match ISO week grouping for month headers).
- **Day cell:** day-of-month numeral in the corner; missions stacked vertically
  below (flex column, gap-1).
- **Month header:** full-width bar, `position: sticky; top: 0; z-index: 10`,
  background `bg-background` with bottom border. Shows `"March 2026"` (localized
  `Intl.DateTimeFormat` month + year).
- **Today:** subtle ring or accent on the day cell border.

### 4.2 MissionCalendarCard

Simpler than `MissionListCard.tsx`:

| Element | Behavior |
| --- | --- |
| Background | Project color at ~14% opacity (reuse `missionCheckboxColors` tint logic from `MissionCardPrimitives.tsx`) with border in full project color |
| Checkbox | `MissionCompleteCheckbox` — same as list |
| Title | Single line, truncated; strikethrough when `statusType === 'complete'` |
| `displayId` | Mono `text-[11px]` (optional; keeps parity with list) |
| Click (card body) | Open mission panel |
| Drag handle | Optional for v1 — entire card draggable except checkbox (stopPropagation on checkbox) |

Omit from v1 card: assignee avatar, Everhour timer, objective count badge, due date
badge (redundant on calendar), drag-reorder grip for status columns.

### 4.3 Empty and edge states

| State | Treatment |
| --- | --- |
| No missions in project | Existing `EmptyState` in `BoardPage` (unchanged) |
| Filters exclude all missions | Existing filtered empty state (unchanged) |
| Missions exist but none have `dueDatetime` | Calendar-specific empty: "No scheduled missions" + hint to set due dates in mission panel or drag from list |
| Day with zero missions | Render empty droppable cell (min-height for drop target) |

## 5. Data model & grouping

### 5.1 Client-side grouping

```ts
type DayKey = string; // 'YYYY-MM-DD' in local timezone

function missionDayKey(dueDatetime: string): DayKey;

function groupMissionsByDay(
  missions: MissionDto[]
): Map<DayKey, MissionDto[]>;
```

- Parse `dueDatetime` with `new Date()`; bucket by **local calendar date** (match
  how `DueDateEditor` displays dates).
- Sort missions within a day: `boardPosition` ascending, then `sequenceNumber`
  descending (consistent with `listMissions` ordering).
- Only include missions where `dueDatetime !== null`.

### 5.2 Visible date window (infinite scroll)

Maintain scroll state in `MissionCalendarView`:

```ts
interface CalendarWindow {
  anchor: Date;        // typically today, reset on project change
  monthsBefore: number; // start at 3, grow on scroll-up
  monthsAfter: number;  // start at 6, grow on scroll-down
}
```

- Render all days from `startOfMonth(anchor - monthsBefore)` through
  `endOfMonth(anchor + monthsAfter)`.
- **Sentinel elements:** `IntersectionObserver` (or scroll-threshold check) on
  top/bottom sentinels prepends/appends one month of days when user nears the
  edge. Cap growth is unnecessary for v1; typical projects have bounded mission
  counts.
- On first mount, `scrollIntoView` the cell containing `anchor` (today) so the
  user lands on the current month.

No new dependency required. If profiling shows jank with 12+ months × 7 columns
× many cards, a follow-up can add `@tanstack/react-virtual` for row virtualization
only.

### 5.3 Undated missions

Per objective ("presents missions with due dates"), **do not** place undated
missions on the grid in v1. Surface the calendar-specific empty state when the
filtered set has missions but zero dated ones.

## 6. Drag and drop design

Calendar DnD is **orthogonal** to `useBoardColumnDnd` (status column reorder).
Create a dedicated hook:

### `useCalendarDueDateDnd`

```ts
export type CalendarDndResult = {
  activeMissionId: string | null;
  optimisticDayByMissionId: Map<string, DayKey> | null;
  dndContextProps: /* same shape as BoardDndResult['dndContextProps'] */;
};
```

**Droppable ids:** `day:${DayKey}` (prefix avoids collision with mission ids).

**Draggable ids:** mission id (string), same as board.

**Flow:**

1. `onDragStart` — capture `activeMissionId`, seed optimistic map from current
   grouping.
2. `onDragOver` — when over a day droppable, move mission id in optimistic map.
3. `onDragEnd` — compute `nextDueDatetime` via shared `buildDueDatetime`:
   - If mission already had a due date: preserve UTC hours/minutes, change
     calendar date to target day (extract `buildDueDatetime` from
     `DueDateEditor.tsx` → `webapp/web/lib/due-datetime.ts`).
   - If no prior due date: use noon UTC on target day (same default as editor).
4. Call `useUpdateMission(missionId).mutate({ dueDatetime })`.
5. On mutation error, revert optimistic map.
6. On success, `useUpdateMission` already invalidates mission queries; drop
   optimistic override when grouped data matches.

**Permissions:** Disable dragging when user lacks `mission:update` (match board
drag gating if/when RBAC gating is wired; today board drag is always enabled).

**Scheduled missions:** Dragging sets `dueDatetime` only; does not modify
`schedule_id`. Document in UI tooltip if mission has `scheduleId` (optional v1
polish).

### Day cell component

`CalendarDayCell` — `useDroppable({ id: \`day:${dayKey}\` })`, highlights on
`isOver`, renders stacked `MissionCalendarCard` components inside a
`SortableContext` only if within-day reorder is desired.

**Within-day reorder:** Not required by objective ("vertically like a list" =
layout, not order). Skip within-day sortable for v1; drop order follows
`boardPosition`.

## 7. Component breakdown

| File | Responsibility |
| --- | --- |
| `webapp/web/pages/MissionCalendarCard.tsx` | Presentational card |
| `webapp/web/pages/MissionCalendarView.tsx` | Window state, month headers, day grid, DnD context |
| `webapp/web/pages/CalendarDayCell.tsx` | Single day droppable + mission stack |
| `webapp/web/pages/useCalendarDueDateDnd.ts` | Calendar-specific DnD state machine |
| `webapp/web/lib/calendar-utils.ts` | `dayKey`, `addMonths`, `eachDayInRange`, `groupMissionsByDay`, month label |
| `webapp/web/lib/due-datetime.ts` | `buildDueDatetime`, `parseDueDate` (extracted from `DueDateEditor`) |
| `webapp/web/pages/board-shared.ts` | Extend `BoardView`; update storage read/write |
| `webapp/web/pages/MissionsViewToggle.tsx` | Add Calendar tab + `CalendarDays` icon |
| `webapp/web/pages/BoardPage.tsx` | Branch `view === 'calendar'` → `MissionCalendarView` |

### `MissionCalendarView` props (mirror `MissionListView` subset)

```ts
{
  missions: MissionDto[];
  projectId: string;
  projectColor: string | null;
  selectedMissionId?: string;
  onCompleteMission?: (missionId: string) => void;
}
```

`BoardPage` passes `filteredMissions` (same as list).

## 8. Integration in `BoardPage`

```tsx
// After existing list branch:
) : view === 'calendar' ? (
  <MissionCalendarView
    missions={filteredMissions}
    projectId={projectId}
    projectColor={projectColor}
    selectedMissionId={selectedMissionId}
    onCompleteMission={completeStatusId ? handleCompleteMission : undefined}
  />
) : (
  <MissionListView ... />
)}
```

Note: reorder the ternary so board / list / calendar are explicit (current code
uses `view === 'board' ? ... : <MissionListView>`).

Calendar view does **not** use `useBoardColumnDnd` or status columns.

## 9. Styling notes

- Reuse existing design tokens (`border-border`, `bg-muted/40`, `text-muted-foreground`).
- Project color tint: extract shared helper from `missionCheckboxColors` →
  `projectColorTint(color, alpha)` in `MissionCardPrimitives.tsx` or
  `calendar-utils.ts`.
- Selected card: same `bg-primary/10 ring-primary/30` as list when
  `mission.id === selectedMissionId`.
- Sticky month header must set `background` opaque enough to cover scrolled day
  content (`bg-background/95 backdrop-blur-sm`).

## 10. Testing plan

| Layer | Tests |
| --- | --- |
| Unit | `calendar-utils.test.ts` — grouping, day key timezone edge cases, month range expansion |
| Unit | `due-datetime.test.ts` — `buildDueDatetime` preserves time component |
| Unit | `useCalendarDueDateDnd` — optimistic map updates (extract pure reducer if needed) |
| Manual | Scroll up/down loads more months; sticky headers stay visible |
| Manual | Drag mission to new day → due date updates in panel + card moves |
| Manual | Filters hide missions on calendar |
| Manual | Complete checkbox works without opening panel |
| Manual | Realtime: edit due date in panel → card moves on calendar without refresh |

Add tests to `webapp/package.json` `test` script entry list.

## 11. Documentation updates

- `webapp/docs/ui/02-mission-board.md` — add Calendar section (layout, DnD, undated
  behavior).
- `webapp/docs/ui/00-structure-and-information-architecture.md` — mention
  `?view=calendar` or localStorage view key if URL sync is added later.

URL search param sync (`?view=calendar`) is **optional v1**; board doc mentions
URL state but current implementation uses `localStorage` only. Match existing
pattern (localStorage) for consistency unless product asks for deep links.

## 12. Phased implementation

### Phase 1 — Shell (M)

1. Extend `BoardView` + toggle + storage.
2. Add `calendar-utils.ts` and `MissionCalendarView` with static window
   (today ± 3 months), no DnD.
3. `MissionCalendarCard` + wire into `BoardPage`.
4. Sticky month headers + scroll-to-today.

### Phase 2 — Interaction (M)

1. Extract `due-datetime.ts`; implement `useCalendarDueDateDnd`.
2. `CalendarDayCell` droppables + drag overlay.
3. Optimistic updates + error revert.
4. Empty state for zero dated missions.

### Phase 3 — Polish (S)

1. Infinite scroll sentinels.
2. Today highlight, selected card ring.
3. Unit tests.
4. UI doc updates.

**Effort:** M (~2–3 days) for Phases 1–2; S for Phase 3.

## 13. Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Week start day | Monday (ISO); configurable later |
| 2 | Show undated missions in a sidebar | Defer; empty state is enough for v1 |
| 3 | My Missions calendar | Follow-up ticket after project calendar ships |
| 4 | URL `?view=calendar` deep link | Defer; align with future board URL-state work |
| 5 | Within-day mission ordering on calendar | Use board order; no within-day DnD in v1 |
| 6 | Drag onto day clears schedule? | No — `dueDatetime` override only, per API contract |

## 14. Acceptance criteria

- User can switch Board → List → Calendar from the project board; choice persists
  across reload.
- Calendar shows only missions with a due date that pass active filters.
- Month labels remain visible (sticky) while scrolling through days.
- Scrolling up/down reveals additional months without a full page reload.
- Each mission appears as a `MissionCalendarCard` with project-color background,
  checkbox, and title; click opens mission panel.
- Dragging a card to another day updates its due date and the card moves to the
  new day after save.
- Multiple missions on the same day stack vertically.
- Data loads via `useMissions`; changes from agents or other clients appear via
  existing realtime invalidation without refresh.
