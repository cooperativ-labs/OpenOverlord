# Mission Status Indicators & Notification Profiles

## The Question

The blocking-question work (coo:341, objective 1) added an orange corner dot to the
mission card, driven by a `MissionDto.hasUnseenBlockingQuestion` flag and cleared when
the mission is opened. The follow-up question:

> Does it make sense to generalize this so that we can represent other statuses, each
> with their own color and notification profile? Blocking questions are yellow-orange and
> may have a particular audio file for their native notification. Later we might add a
> "returned-to-execute" type that marks missions sent back to the execute stage. Should
> we make this a general service, or implement each status independently?

**Recommendation: build a shared, declarative _status catalog_ (one data module that is
the single source of truth for each mission status' color, label, seen-tracking, and
notification profile), but keep the two _delivery pipelines_ — card indicators and native
notifications — as thin, separate consumers of that catalog. Do _not_ build a single
monolithic "notification service."** Generalize the DB seen-tracking into one table now;
generalize the rendering/notification code lazily, when the second status lands.

## Why Not "Nothing" And Why Not "One Big Service"

There are already **two independent pipelines** that both encode a per-status list, and
they overlap. Understanding them is the whole basis for the recommendation.

### Pipeline A — card indicators (derived, persistent, pull-based)

- `MissionDto` carries computed boolean flags, produced by SQL aggregates in
  `backend/repository.ts` (`hasExecutingObjective`, `hasUnseenBlockingQuestion`,
  `hasCompletedObjective`, `hasPendingObjectiveWithInstructions`).
- `webapp/web/pages/missionCardState.ts#getMissionCardState` maps those flags to a
  `MissionCardState` (`shimmer`, `blockingQuestion`, `objectiveCount`,
  `objectiveCountAlert`).
- `webapp/web/pages/MissionCardStateOverlay.tsx` renders overlays from that state so every
  card surface (board, list, drag overlay) stays in sync.
- These states are **ambient**: recomputed on every read, shown for as long as the
  condition holds, and cleared by a "seen" stamp (`blocking_question_seen_at`).

### Pipeline B — native notifications (transient, edge-triggered, push-based)

- `webapp/web/lib/native-workflow-notifications.ts` already has a
  `WorkflowNotificationKind` union: `agent_started | ready_for_review | blocking_question |
  launch_failed`.
- `selectWorkflowNotificationCandidates` maps realtime `EntityChange` rows to candidates;
  `notifyWorkflowChanges` dedupes by key and fires a **one-shot** OS/browser toast with a
  hardcoded `title`/`body` per kind.
- Delivery goes through the desktop bridge `window.overlord.showNotification({title, body,
  tag})` (`webapp/web/types/overlord-desktop.d.ts`) or the browser `Notification` — **no
  sound field exists yet**.
- Preferences are a single global on/off (`native-notification-preferences.ts`,
  `NotificationsPage.tsx`); the "You will be notified when" list is also hardcoded.

**These two pipelines have fundamentally different trigger models** — A is a persistent
function of current DB rows, B is a one-shot reaction to a change event. Forcing them into
one runtime "service" would fight both models (B would have to poll derived state; A would
have to remember what it already fired). So the right seam is **not** a shared runtime — it
is a shared **description of what each status _is_**, which both pipelines read.

Doing nothing is also wrong: `blocking_question` is _already_ duplicated across both
pipelines with its identity re-encoded in each, and the objective names a concrete second
persistent status (`returned_to_execute`). Shimmer + blocking-question + returned-to-execute
is three — the rule-of-three point where extracting the catalog pays for itself.

## Recommended Architecture

### 1. A declarative status catalog (the one new abstraction)

A single data module — no runtime, just descriptors — that both pipelines import.
Suggested home: `packages/contract` (shared by backend + webapp) or a
`webapp/web/lib/mission-status-catalog.ts` if we keep it frontend-only initially.

```ts
export interface MissionStatusIndicator {
  id: 'blocking_question' | 'returned_to_execute'; // extend as statuses are added
  /** Human label for aria + settings copy. */
  label: string;
  /** Corner-dot Tailwind classes (color). null → no card dot for this status. */
  dotClassName: string | null;
  /** aria-label for the dot. */
  ariaLabel: string;
  /**
   * Whether this status is "seen"-tracked: it shows on the card until the user
   * opens the mission, at which point it clears. Drives the DB seen row + the
   * clear-on-open write. (false → transient/notification-only.)
   */
  seenTracked: boolean;
  /** Native-notification profile. Omit for card-only statuses. */
  notification?: {
    title: string;
    /** Bundled audio asset played with the OS/browser toast. */
    soundUrl?: string;
  };
}
```

The existing `blocking_question` becomes the first catalog entry (dot = `bg-orange-500`,
`seenTracked: true`, `notification.title = 'Blocking question'`). `returned_to_execute`
becomes the second when built. `shimmer` stays special-cased (it is an animated full-card
overlay driven by live objective state, not a corner dot with seen-tracking) — the catalog
is for **corner indicators / notifiable statuses**, not every visual affordance.

### 2. Card side — iterate the catalog instead of hardcoding dots

- `getMissionCardState` returns, in addition to `shimmer`/`objectiveCount`, an
  `activeIndicators: MissionStatusIndicator[]` derived by mapping each `MissionDto` status
  flag → its catalog entry.
- `MissionCardStateOverlay` iterates `activeIndicators` and stacks corner dots with a small
  offset (e.g. `top-2`, `top-6`, …) so multiple statuses don't collide.
- Adding a status becomes: add a catalog entry + one `MissionDto` flag; **no overlay markup
  changes.**

### 3. Notification side — read title/sound from the catalog

- Replace the inline `switch` title strings in `notifyWorkflowChanges` with a catalog
  lookup keyed by the candidate kind.
- Add an optional `soundUrl` to the desktop bridge `showNotification` payload and to the
  browser `Notification` path (via an `Audio` play or the notification's sound option), so
  the blocking-question toast can carry its yellow-orange "please look at me" chime.
- The "You will be notified when" list in `NotificationsPage.tsx` can be generated from the
  catalog, and (future) per-status toggles become a natural extension.

### 4. DB — one generalized seen table, not a column per status

`blocking_question_seen_at` is a dedicated column on `missions`. For **one** seen-tracked
status that is fine; for several it becomes column sprawl and a new migration each time.
Recommendation: introduce a generalized

```
mission_status_seen(mission_id, status_id, seen_at, PRIMARY KEY (mission_id, status_id))
```

table. The "unseen?" aggregate then joins this table filtered by `status_id` instead of a
per-status column, and clear-on-open upserts `(mission_id, status_id, now())`. This keeps
adding a seen-tracked status to a **catalog entry + one flag + one aggregate**, no schema
change. Migrate the existing `blocking_question_seen_at` values into the new table as part
of introducing it (or leave the column and add the table only for status #2 if we want to
minimize churn — see Phasing).

## What NOT To Build

- **No monolithic runtime notification service.** The two pipelines stay separate; only the
  descriptors are shared. A unified service would have to reconcile push vs. pull semantics
  and would be harder to reason about than two small consumers.
- **No per-status user preference matrix yet.** Keep the single global toggle; the catalog
  makes per-status toggles cheap to add later, but that is not asked for.
- **No server-driven catalog / DB-configured statuses.** Statuses are a closed, code-owned
  set (they ship with rendering + sound assets), so a static code module is correct — not a
  `mission_statuses` config table.

## Phasing

1. **Extract the catalog for the existing status (pure refactor, no behavior change).**
   Move `blocking_question`'s identity into the catalog; have `getMissionCardState` /
   `MissionCardStateOverlay` iterate it. Ships the seam with zero new surface.
2. **Add the sound dimension.** Extend the desktop bridge + browser path with `soundUrl`;
   attach the blocking-question chime. This is the first thing the objective explicitly
   wants that does not exist today.
3. **Add `returned_to_execute` as the proof of generality.** New catalog entry + one
   `MissionDto` flag + one aggregate. If we adopt the generalized `mission_status_seen`
   table, do it here (migrating `blocking_question_seen_at` in) so status #2 needs no new
   column. This is the step that validates the abstraction against a real second case.
4. **(Optional) Generate the settings "notified when" list and per-status toggles from the
   catalog.**

## Implementation Status (coo:341, objectives 3–4)

**All phases are implemented.**

- **Phase 1 — catalog + card iteration (done).** `webapp/web/lib/mission-status-catalog.ts`
  is the declarative `MissionStatusIndicator` catalog (id, label, `dotClassName`,
  `ariaLabel`, `seenTracked`, optional `notification`). `getMissionCardState` now returns
  `activeIndicators: MissionStatusIndicator[]` (mapping `MissionDto` flags → catalog
  entries) instead of a hardcoded `blockingQuestion` boolean, and
  `MissionCardStateOverlay` iterates them, stacking corner dots at
  `top: ${0.5 + index}rem`. Adding a card status is now a catalog entry + one `MissionDto`
  flag — no overlay markup change. Behavior for `blocking_question` is unchanged.
- **Phase 2 — sound dimension (done, plumbing only).** The catalog's `notification`
  profile carries an optional `soundUrl`. It is threaded end-to-end: the desktop bridge
  (`showNotification` payload → `desktop/src/preload.ts` → `desktop/src/ipc.ts`) and the
  browser path both accept it, and `native-workflow-notifications.ts` plays the chime in
  the renderer via `Audio` (so it works identically in the desktop webview and the
  browser) while silencing the OS default to avoid a doubled cue. The blocking-question
  toast reads its title from the catalog. **No audio asset ships yet** — `soundUrl` is
  left unset; drop a bundled URL onto the catalog entry to activate the chime.
- **Phase 3 — `returned_to_execute` + generalized seen table (done).**
  - `database/*/migrations/20260717133400_mission_status_seen.sql` adds
    `missions.blocking_question_seen_at`, creates
    `mission_status_seen(mission_id, status_id, seen_at PRIMARY KEY)`, migrates existing
    seen values into it, and adds `missions.returned_to_execute_at`.
  - All three status-transition paths (`patchMissionFieldsTx`, `reorderBoardColumn`,
    `moveMissionProjectTx`) now stamp `returned_to_execute_at = now` when a mission moves
    INTO an execute-type status FROM any non-execute status. This avoids the event-type
    CHECK constraint problem (no new `mission_events.type` needed).
  - `backend/repository.ts`: all three aggregate SQL blocks updated to look up seen_at in
    `mission_status_seen` instead of `blocking_question_seen_at`; `has_unseen_returned_to_execute`
    added. `markMissionBlockingQuestionSeen` → `markMissionStatusesSeen` (clears all
    unseen statuses on open via upsert into `mission_status_seen`).
  - `packages/contract/src/index.ts`: `MissionDto.hasUnseenReturnedToExecute: boolean` added.
  - Catalog: `MissionStatusIndicatorId` extended to `'blocking_question' | 'returned_to_execute'`;
    `returned_to_execute` entry added (blue dot, seen-tracked, notification title).
  - `getMissionCardState` maps `hasUnseenReturnedToExecute` → catalog entry.
  - `native-workflow-notifications.ts`: `returned_to_execute` kind added — fires on
    mission entity changes where `returned_to_execute_at` is in changedFields.
  - 68 webapp tests pass; webapp + backend + desktop typechecks clean.

## Bottom Line

Generalize the **description** (one catalog) and the **DB seen-tracking** (one table), keep
the two **delivery pipelines** separate and thin. This removes the existing
`blocking_question` duplication, makes `returned_to_execute` a ~3-line addition, and adds
the audio-profile capability the objective calls for — without over-building a speculative
service around a single indicator. Recommended first step is the pure catalog refactor
(phase 1), which is safe to land independently of any new status.
