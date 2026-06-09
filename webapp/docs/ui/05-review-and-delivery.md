# 05 — Review & Delivery

The screen that makes Overlord useful *after* an agent finishes. When a
delivery moves a ticket to `review`, this surface lets a human evaluate what was
asked, what happened, what was delivered, what changed and why, and what still
needs follow-up — **without opening the original agent chat**. It must be easier to
scan than terminal logs.

**Route:** `/p/:projectId/tickets/:ticketId/review` (also embedded as the top of
ticket detail when status is `review`).

---

## Layout

```
┌─ Review · 1:1421  Token rotation ─────────────────────  [status: review] ────────────┐
│ Delivered by claude·opus · objective "Add rotation" · session a1b2… · 12m ago         │
│ [ ✓ Complete ]  [ + Add follow-up objective ]  [ ⟲ Reopen / ask for changes ]         │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Delivery summary ───────────────────────────────────────────────────────────────┐ │
│ │ Narrative summary (what was asked, what happened, what's left). Markdown.         │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ Rationale coverage ─────────────────┐  ┌─ Artifacts ──────────────────────────────┐ │
│ │ 4 changed files · 4 with rationale ✓ │  │ ▸ test_results  "vitest 41 pass"          │ │
│ │ ▓▓▓▓ 100% covered                    │  │ ▸ next_steps    "wire rotate to UI"       │ │
│ │  src/auth/token.ts        ✓ rationale│  │ ▸ migration     "add user_token_scopes"   │ │
│ │  src/auth/token.test.ts   ✓ rationale│  │ ▸ note / url / decision …                 │ │
│ │  src/auth/index.ts        ✓ rationale│  └──────────────────────────────────────────┘ │
│ │  src/rbac/authorizer.ts   ✓ rationale│  ┌─ Objective completion history ───────────┐ │
│ │  [ open diff → Changes ]             │  │ 1 ✓ Plan       complete  · session …      │ │
│ └──────────────────────────────────────┘  │ 2 ✓ Add rotation complete · session a1b2 │ │
│ ┌─ Human action / follow-up ──────────────┐│ 3 ◷ Wire UI    draft                      │ │
│ │ thread of asks/answers, decisions, notes ││  (redelivery indicator if pending)        │ │
│ └──────────────────────────────────────────┘└──────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Sections

### Delivery summary
- The `deliveries.summary` rendered as markdown — a **narrative**, not a command
  log (the protocol requires this). Shown at the very top of the review state.
- Header line: delivering agent/model, the objective delivered, the session (or
  "recorded work — no session" for `record-work` deliveries), and time.
- **Follow-up deliveries do not replace prior ones**: a delivery history selector
  lets the reviewer page through prior deliveries; the latest is shown by default.

### Rationale coverage
- The core review affordance. Aggregates `changed_files` for the objective(s) and
  shows which have a `change_rationale` (`label`, `summary`, `why`, `impact`,
  `hunks`). A coverage bar shows covered vs uncovered.
- **Uncovered meaningful changes are flagged** — delivery validates coverage, so an
  uncovered file is either a known skip (formatting noise) or a gap worth raising in
  review. Each file links into the **Changes** tab/diff (doc 06) annotated with its
  rationale label and hunk headers.
- Files no longer in the local diff are shown as "observed earlier, no current
  diff" rather than silently dropped (per change-tracking rules).

### Artifacts
- Grouped by `artifacts.type`: `test_results`, `next_steps`, `note`, `url`,
  `decision`, `migration`. Each `ArtifactCard` shows `label` + `content`
  (markdown/code aware). `url` artifacts are links; `test_results` get a
  pass/fail-styled header. Large outputs are attachments, not inline artifacts —
  shown as downloadable objective attachments.

### Human action / follow-up
- The conversation surface for review: prior `ask`/answer pairs, `decision`s,
  `discussion_summary`s, and a composer to add a follow-up note. Ordinary
  discussion here **does not** reopen execution (it stays in review); only an
  explicit follow-up-work signal does (below).

### Objective completion history
- Which objective each delivery completed and via which session; a **redelivery
  indicator** when an objective is `pending_delivery` (follow-up execution happened
  after a prior delivery and needs redelivery).

---

## Review actions

| Action | Effect | Endpoint |
| --- | --- | --- |
| **Complete** | Ticket `review → complete` | `PATCH /tickets/:id` status (service-layer) |
| **Add follow-up objective** | Append a new objective for more work | `POST /protocol/add-objectives` |
| **Reopen / ask for changes** | Post a follow-up requesting changes; optionally begin follow-up work | `POST /protocol/update` (`discussion`) or `--begin-follow-up-work --follow-up-intent execution` |
| **Answer an ask** | Record human answer | `POST /protocol/update --event-type user_follow_up`/`decision` |
| **Approve next** | If a gated next objective is awaiting approval | doc 04 approval gate |

**Follow-up semantics the UI must respect:**

- A delivered ticket stays in `review` during discussion. Notes, decisions, and
  clarifications do not move it back to `execute`.
- "Ask for changes that requires code work" is a deliberate, explicit transition:
  the UI calls the `begin-follow-up-work` signal, the objective becomes
  `pending_delivery`, and a follow-up delivery later returns it to `complete`.
- The UI presents these as two clearly different buttons ("Add a note / ask" vs
  "Reopen for changes") so a reviewer never accidentally reopens execution.

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| Delivery summary + history | `GET /tickets/:id/deliveries` → `['ticket', id, 'deliveries']` | `delivery` insert/update → new delivery card; status badge |
| Artifacts | within deliveries payload | `artifact` deltas |
| Rationale coverage | `GET /tickets/:id/changes` (`changed_files`+`change_rationales`) | `changed_files`/`change_rationale` deltas update coverage live |
| Follow-up thread | `GET /tickets/:id/events` | `ticket_event` deltas (`ask`, `decision`, `user_follow_up`) |
| Objective history | `['ticket', id]` | `objective` deltas (incl. `pending_delivery`) |

Because coverage reads the live `changed_files`, a reviewer watching a follow-up
session sees coverage update as the agent records rationales — review is live, not a
post-hoc snapshot.

---

## States

- **Not yet delivered:** if opened on a non-`review` ticket, show "No delivery yet"
  with the current objective/session status and a link back to detail.
- **Missing rationale coverage:** prominent but non-blocking warning listing
  uncovered meaningful files (this is the human's call to accept or push back).
- **`record-work` delivery:** clearly labeled "recorded from chat — no live
  session"; session attribution is null.
- **Pending redelivery:** banner that the latest follow-up work hasn't been
  re-delivered yet.
- **Multiple deliveries:** history pager; default to latest; never destroy prior
  delivery records.

---

## Capability gating

- Review actions gated by RBAC (`ticket:update`, `objective:submit`) when Group 1
  is installed.
- Actor attribution on follow-up events shows real users only when Group 1 is
  installed; otherwise the implicit user/agent.

---

## Acceptance criteria

- A delivered ticket can be fully reviewed here — summary, artifacts, changed files
  and rationale coverage, and follow-up actions — without opening the agent chat.
- Rationale coverage clearly distinguishes covered vs uncovered meaningful changes
  and links each file to its annotated diff.
- Artifacts are grouped by type and visually distinct from objective attachments.
- Ordinary review discussion keeps the ticket in `review`; reopening for code work
  is an explicit, separately-labeled action that moves the objective to
  `pending_delivery`.
- Follow-up deliveries are added without destroying earlier delivery history, and a
  redelivery-needed state is visible.
- Completing the ticket moves it to `complete` via the service layer.
</content>
