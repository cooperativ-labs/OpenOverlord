# Web Interface Implementation Plan

This is the build plan for the Overlord realtime React web interface. It turns the
already-delivered design material into an ordered, dependency-aware implementation
sequence.

It is grounded in, and should be read alongside:

- [Framework Recommendation](framework-recommendation.md) — the stack (Vite + React + TypeScript + TanStack Router/Query + Serwist + shadcn/Tailwind) and *why*.
- [Web App Requirements](web-app.md) — the MVP scope, deferred scope, data/API boundary rules, and acceptance criteria.
- [UI Design Documents](ui/README.md) — the structure/IA doc (`ui/00`) and one detailed spec per page (`ui/01`–`ui/10`).
- [`CONTRACT.md`](../../CONTRACT.md) — this module is the **REST API Layer** (`rest`); the React client is a pure consumer of it.
- The [REST API Boundary](../../database/docs/09-database-schema-contract.md#rest-api-boundary) and Realtime Strategy in the schema contract.

This plan is documentation. It does not write application code or change the
contract; it specifies the order in which that work should happen and the
decisions and contract actions each step depends on.

---

## 1. Scope of this plan

**In scope:** building the browser web interface defined in `ui/00`–`ui/10`, plus
the minimum REST + realtime boundary the interface must consume, sequenced so the
realtime model is proven early and gated surfaces land last.

**Explicitly out of scope** (per [web-app.md](web-app.md) "Deferred Web App
Scope"): marketing/hosted-auth/OAuth/passkey pages, org members/invitations,
Slack/Everhour, the feed, mobile/Electron surfaces, remote/SSH target management
beyond display, graph/hotspot visualizations, admin-of-admins, and a public docs
site. None of these reserve primary navigation; they can attach later behind
capability gates without reshaping the IA (`ui/00` §9).

---

## 2. Current state and the core dependency

A clear-eyed starting point, because it determines the whole sequence.

| Layer the UI needs | Status today |
| --- | --- |
| React frontend | None — `webapp/` contains docs only |
| REST endpoints (`/projects`, `/missions`, `/protocol/*`, …) | None implemented |
| `/realtime` SSE/WebSocket + `/sync/changes` feed | None implemented |
| Shared service layer (CLI/protocol/REST call into it) | Not present in `src/` |
| Auth + RBAC | Partially present (`auth/src/auth/`, `auth/src/rbac/`) |
| Database schema / `entity_changes` feed | Specified in the schema contract; not migrated |

**The central fact:** the UI design docs describe a client that is a *read-through
cache over the REST boundary, invalidated by the `entity_changes` feed* (`ui/00`
§4). That boundary **does not exist yet**. The web interface cannot be built in
isolation — it has a hard upstream dependency on the `rest` surface and the
realtime feed, which in turn depend on the service layer and schema.

This plan therefore treats the work as **two coordinated tracks** that meet at a
typed API contract:

```
   Track B (backend, rest module)            Track F (frontend, this plan's focus)
   schema + service layer                    Vite React SPA
        │                                          │
        ├── REST endpoints  ─────┐        ┌─────────┤ TanStack Query cache
        └── /realtime + /sync ───┤        │         └ realtime invalidation loop
                                 ▼        ▼
                        ┌──────────────────────────┐
                        │  Typed API contract       │  ← single source of truth:
                        │  (DTOs + endpoints +      │     OpenAPI or shared TS types,
                        │   realtime delta shape)   │     derived from the logical schema
                        └──────────────────────────┘
                                 ▲
                        Mock server (MSW) implements the
                        contract so Track F starts before
                        Track B is finished.
```

The frontend is built **contract-first against a mock**, then integrated against
the real backend as endpoints land. This removes the "frontend blocked on
backend" serialization without letting the two drift.

---

## 3. Decisions to lock before coding (and their contract impact)

These are the load-bearing decisions. Resolve them first; several require a
contract action and must follow the [component-contract skill](../../.claude/skills/component-contract/SKILL.md)
workflow (the contract update lands **before** the code).

### 3.1 Module layout inside `webapp/`

The `webapp` module owns the `rest` contract component *and* houses the browser
client (see [README](../README.md): "the web control center … and the REST/realtime
API that backs it"). The React client implements **no** contract surface — it only
consumes `rest`. Split the module so the contract component stays unambiguous:

```
webapp/
  server/                ← the `rest` contract component (REST routes + realtime)
    <area>/routes.ts     ← per AGENTS.md convention (missions/, projects/, …)
    realtime/            ← SSE/WebSocket emitter from entity_changes
  web/                   ← the React SPA (this plan's primary subject; pure consumer)
    app/ routes/ features/ components/ lib/ …
  shared/                ← the typed API contract (DTOs, endpoint + delta types)
  docs/                  ← existing specs (this file, framework-recommendation, ui/)
```

> **Contract note:** `webapp/AGENTS.md` currently shows route files directly under
> `webapp/<area>/`. Adopting `webapp/server/<area>/` is a documentation
> clarification within the same module; update `webapp/AGENTS.md`'s file-placement
> section when the split is created. No contract-version bump (no stable interface
> changes), but keep AGENTS.md and reality in sync.

### 3.2 Contract-first typed API

Define the REST + realtime contract once and share it between `server/` and
`web/`. The schema contract already requires this: DTOs use the **camelCase
logical field names** and "the implementation should define the schema once in a
typed/declarative source and generate adapter DDL, REST DTO field names … from it."
Pick one of: an OpenAPI document, or a hand-authored shared TS types package in
`webapp/shared/`. Either way, validate request/response shapes with **zod v4**
(follow the [zod-v4-patterns skill](../../.claude/skills/zod-v4-patterns/SKILL.md)).

### 3.3 Ratify the UI-implied REST reads (first contract action)

`ui/00` §4.1 calls out reads the designs depend on that are **not yet enumerated**
in the REST API Boundary. They are owned by the `rest` module and expose domain
resources (not raw tables), so they fit the existing boundary. Ratify them in the
[REST API Boundary](../../database/docs/09-database-schema-contract.md#rest-api-boundary)
**before** building the pages that need them:

| Endpoint | Feeds | Page docs |
| --- | --- | --- |
| `GET /missions/:id/changes` | `changed_files` + `change_rationales` (coverage) | `ui/05`, `ui/06` |
| `GET /runner/status` | local runner identity + queue summary | `ui/04` |
| `GET /execution-requests?projectId=` | runner queue | `ui/04` |
| `GET /capabilities` | which à-la-carte groups / REST features are installed | all (gating, `ui/00` §5) |
| `GET /connectors` | connector install/doctor state + permission inbox | `ui/07` |

Procedure per the contract: update `09-database-schema-contract.md` (REST API
Boundary) and `CONTRACT.md` (REST API Layer), bump the contract version only if a
previously-stable response schema changes (these are additive reads, so likely no
bump), then implement. `GET /capabilities` is the keystone — capability gating
(§3.5) is unbuildable without it.

### 3.4 Realtime transport

Per the framework recommendation: **SSE first**, WebSocket optional later. The
client contract is transport-agnostic: compact `entity_changes` deltas ordered by
monotonic `seq`, with `/sync/changes?after=<seq>` for catch-up (`ui/00` §4.3). The
feed is **secret-redacted** by the schema contract, so it is safe to stream to the
browser. Durable cursor resume needs Group 6; without it the client falls back to
stateless polling of `/sync/changes` — identical behavior, only cursor durability
across restarts is lost.

### 3.5 Capability gating model

The UI must adapt to which [table groups](../../database/docs/10-database-table-groups.md)
are installed (`ui/00` §5). Drive this from `GET /capabilities` exposed via a
React capability context; **hide** (not disable) gated nav and embedded actions.
Keep RBAC denials (permitted-but-forbidden, machine-readable reason) distinct from
capability gating (surface absent entirely).

### 3.6 Local-backend vs browser-only

Two features require a **local backend** with filesystem/VCS access, not a table
group: Current Changes diffs (`ui/06`) and live runner observation (`ui/04`). The
UI must detect local-backend presence and degrade to read-only metadata + the
equivalent `ovld` command when it is absent. Treat "local backend present" as a
first-class capability flag alongside table groups.

---

## 4. Tooling baseline

Established before Phase 0; mostly from the framework recommendation.

| Concern | Choice |
| --- | --- |
| Build / dev server | Vite (dev server proxies `/api` + `/realtime` to the local backend; prod build served by `ovld serve`) |
| Framework | React + TypeScript (strict) |
| Routing | TanStack Router (typed params + search-param state; URL is source of truth, `ui/00` §3) |
| Server state | TanStack Query (cache keys mirror the resource hierarchy, `ui/00` §4.2) |
| PWA | Serwist via `@serwist/vite` (shell + GET caching; never caches POST) |
| UI kit / styling | shadcn/ui + Tailwind; CSS-variable token set for dark/light + density (`ui/00` §6) |
| Validation | zod v4 (shared with the API contract) |
| Mock API | MSW implementing the typed contract + a scripted realtime stream |
| Unit / component tests | Vitest + React Testing Library |
| E2E | Playwright (drives acceptance-criteria flows) |
| Lint / format | ESLint + Prettier (match repo conventions) |

---

## 5. Phase 0 — Foundation and the realtime spine

The highest-leverage work: the cross-cutting infrastructure every page inherits,
built once. **Do this before any page.** It also de-risks the single hardest part
(realtime) up front.

1. **Scaffold** `webapp/web/` (Vite + React + TS), Tailwind + shadcn tokens, the
   `webapp/shared/` contract package, and the MSW mock implementing it.
2. **App shell** (`ui/00` §2): three-region topbar/sidebar/main, responsive
   collapse <960px, the global status cluster (runner state, attention counter,
   realtime link state).
3. **Router + route map** (`ui/00` §3): every route deep-linkable and
   reload-safe; mission-detail inner tabs via `?tab=`; project-scoped vs
   workspace-scoped layout split.
4. **Query client + REST client**: typed fetch layer, the cache-key scheme from
   `ui/00` §4.2, the `409`-conflict (revision mismatch) refetch/re-apply pattern.
5. **Realtime + sync client** (the spine): one `/realtime` connection per
   workspace, delta→query-key invalidation map (`ui/00` §4.3), `max(seq)` tracking,
   reconnect via `/sync/changes?after=<seq>`, full-resync fallback, and the
   Live / Catching-up / Polling / Offline state machine (`ui/00` §4.4).
6. **Capability context**: load `GET /capabilities` + local-backend probe; expose
   `useCapability(group)` and gate helpers.
7. **Design system primitives** (`ui/00` §6.3): `StatusBadge`, `ObjectiveStatePill`,
   `PriorityTag`, `EmptyState`, `CopyCommand`, `Toast`/`BlockingBanner`,
   skeletons, and the status-color token set bound to the **closed contract
   vocabularies** (the UI must not invent status words, `ui/00` §6.2).
8. **Cross-cutting states** (`ui/00` §7): loading skeletons, empty-with-CLI-hint,
   scoped inline errors, offline/stale via Serwist.
9. **Serwist registration**: installable shell, cached static assets + GET reads,
   background update flow.

**Phase 0 done when:** the empty shell loads from the Serwist cache offline; the
realtime client (against the MSW stream) shows correct Live/Catching-up/Polling/
Offline transitions and applies scripted deltas to the cache; and `GET /capabilities`
correctly hides a gated nav item in a simulated core-only install.

---

## 6. Milestones

Ordered by dependency and value. The vertical slice comes first (proves the model
end-to-end); the core workflow is built to depth next; operational and
capability-gated surfaces follow (they are hidden in core-only installs, so they
do not block a usable product). Each milestone maps to its design doc and inherits
that doc's acceptance criteria.

Effort is **relative** (S < M < L < XL), not calendar time.

### Stage A — Prove the model

| # | Milestone | Doc(s) | Effort | Key backend deps |
| --- | --- | --- | --- | --- |
| **M1** | **Vertical slice / de-risking spike** | 02, 03, 04, 05 (read-only depth, core groups only) | L | `GET /missions`, `GET /missions/:id`, `…/events`, `…/deliveries`, `POST /protocol/request-execution`, `/realtime`, `/sync` |

M1 is the spike from the prior delivery's next-steps artifact: **board → mission
detail → run an objective → watch it update live → review the delivery**, against
core table groups only. It exercises the realtime spine, capability gating, the
status vocabularies, and the protocol-mirroring mutation path on one thin path
through the app. It is the go/no-go validation of the whole architecture before
breadth work begins.

### Stage B — Core workflow depth

| # | Milestone | Doc | Effort | Notes |
| --- | --- | --- | --- | --- |
| **M2** | Projects & project settings | 01 | M | Project switcher, list, settings, resource directories, status-invariant enforcement (one default/execute/review) |
| **M3** | Mission board (full) | 02 | L | Kanban + list, filter bar in URL state, create-mission modal, drag/keyboard status move (optimistic + reconcile), quick-run with working-dir repair |
| **M4** | Mission detail (full) | 03 | XL | Objective rail + editor, all timeline `EventItem` renderers, inline ask answering, shared-context tab, objective-scoped attachments, the never-transition-locally rule |
| **M5** | Execution & runner | 04 | L | Run control, execution-request queue, runner-status panel, auto-advance approval gate, idempotent re-click safety |
| **M6** | Review & delivery | 05 | L | Delivery summary, rationale coverage bar, artifacts by type, follow-up vs reopen-for-changes distinction, delivery history pager |

M4 (mission detail) is the largest single screen and the heart of "realtime React
interface" — budget accordingly. M5/M6 complete the run→deliver→review loop that
M1 stubbed.

### Stage C — Operational surfaces

| # | Milestone | Doc | Effort | Gate |
| --- | --- | --- | --- | --- |
| **M7** | Current changes (read-only diffs) | 06 | M | Local backend only; degrade to recorded metadata otherwise. Strictly read-only VCS |
| **M8** | Connectors & doctor + permission inbox | 07 | M | Group 4; degrade to static setup guidance otherwise |
| **M9** | Settings (instance) | 08 | M | Local-backend config writes; capabilities panel; danger-zone soft-deletes |

### Stage D — Search and gated multi-user surfaces

| # | Milestone | Doc | Effort | Gate |
| --- | --- | --- | --- | --- |
| **M10** | Search & command palette | 10 | M | `⌘K` always works for `display_id` + nav/actions; ranked FTS gated on Group 8 |
| **M11** | Users, roles & tokens | 09 | L | Group 1; entire surface hidden in core-only. One-time secret reveal; last-admin guard |

The command palette (M10) is partly cross-cutting — its nav/action registry should
be seeded incrementally from Phase 0 onward as each surface lands, then finished as
a milestone. M11 is intentionally last: it is fully hidden in a core-only install,
so the product is complete and usable without it.

### Stage E — Hardening

| # | Milestone | Effort | Covers |
| --- | --- | --- | --- |
| **M12** | PWA, accessibility, performance pass | M | Offline behavior under real backend loss; keyboard model (`ui/00` §8) end-to-end; WCAG AA contrast in both themes; live-region announcements; render perf on dense boards/timelines; bundle/code-split review |

---

## 7. Cross-cutting workstreams

These run across all milestones rather than as discrete steps:

- **Realtime correctness.** Every new query key must register its delta→invalidation
  mapping; every milestone adds a realtime test that drives a scripted delta and
  asserts the UI updates without refetch-by-refresh.
- **Capability gating.** Each gated surface ships with both states tested: installed
  and absent. The core-only matrix is a release gate (`ui/00` §10).
- **Security boundaries** (`ui/README` "Scope boundaries"): no raw secrets re-displayed
  (token reveal exactly once, M11); VCS strictly read-only with no mutation control
  anywhere (M7); no repo contents uploaded except an explicit user attachment.
- **Protocol-as-source-of-truth.** The UI requests transitions via `/protocol/*` and
  reflects the authoritative `revision` + change feed; it never fakes a lifecycle
  transition (optimistic UI only for low-risk edits, always reconciled).
- **Design-system consistency.** Status words come only from the closed contract
  vocabularies; one semantic color means one thing everywhere.
- **Command palette registry.** Grows as surfaces land (§6, M10 note).

---

## 8. Testing & verification strategy

| Level | Tooling | What it covers |
| --- | --- | --- |
| Unit / component | Vitest + RTL | Components, gating helpers, cache-key + delta-mapping logic |
| Contract | zod schemas + shared types | Request/response DTO shapes match the logical-schema camelCase contract; mock and real backend conform |
| Integration | MSW | Pages against a faked API + scripted realtime stream, incl. reconnect/`/sync` catch-up |
| Realtime simulation | MSW SSE harness | Drives `entity_changes` deltas; asserts live updates, Live/Catching-up/Polling/Offline transitions, append-only timeline |
| E2E | Playwright | The acceptance-criteria flows verbatim — esp. `ui/00` §10 and web-app.md "Acceptance Criteria" (create→run via CLI runner→watch live→review→clear stale request→configure connectors) |
| Capability matrix | E2E + component | Core-only install hides every gated surface with no broken links; full install shows all |
| Accessibility | axe + manual keyboard | WCAG AA, keyboard-only operation, SR live regions |

Run the `verify` skill on the running app before each milestone is called done.

---

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Backend (REST/realtime/service layer) not ready | Contract-first + MSW mock; frontend develops against the contract, integrates as endpoints land (§2) |
| Realtime is the hardest part and easy to get subtly wrong | Build the spine in Phase 0; prove it in the M1 vertical slice before breadth; simulation harness in CI |
| Capability-gating combinatorics | Gate via one `GET /capabilities` context; test only the two release-critical configs (core-only, full) per surface, not every permutation |
| Local-backend-only features mistaken for always-available | Treat local-backend as an explicit capability flag; M7/M9 ship the degraded state first |
| UI-implied REST reads never ratified → undeclared surface | Make §3.3 the first contract action; pages that need them are blocked until ratified |
| Scope creep into deferred surfaces | §1 out-of-scope list is a guardrail; the IA reserves no nav for them |
| Optimistic UI faking lifecycle transitions | Hard rule: optimism only for low-risk edits, always reconciled; lifecycle always via protocol + change feed |

---

## 10. Sequencing summary

```
 Contract actions (first):  ratify UI-implied REST reads (§3.3) ─┐
                            lock module layout + typed contract  │
                                                                 ▼
 Phase 0  Foundation + realtime spine + capability ctx + design system
                                                                 │
 Stage A  M1  Vertical slice (board→detail→run→live→review)  ◀── go/no-go
                                                                 │
 Stage B  M2 Projects → M3 Board → M4 Mission detail → M5 Runner → M6 Review
                                                                 │
 Stage C  M7 Changes → M8 Connectors → M9 Settings
                                                                 │
 Stage D  M10 Search/palette → M11 Users/roles/tokens (Group 1)
                                                                 │
 Stage E  M12 PWA / a11y / performance hardening
```

Hard ordering constraints:

- Phase 0 precedes every milestone.
- `GET /capabilities` (§3.3) precedes any gated surface (M7/M8/M10/M11).
- M1 precedes breadth work (it validates the architecture).
- M4 depends on the timeline/objective primitives from M1/M3.
- M5 + M6 complete the loop M1 stubbed.
- M11 last (fully hidden in core-only; product is usable without it).

Within those constraints, Stage B milestones can parallelize across contributors
once Phase 0 lands, since each owns a distinct route subtree over a shared cache.

---

## 11. Definition of done for the web interface

The interface is complete when it satisfies the structure acceptance criteria
(`ui/00` §10), each page's acceptance criteria (`ui/01`–`ui/10`), and the
product-level criteria in [web-app.md](web-app.md):

- Launch lands on the active project's board — never a marketing or forced-login page.
- A user can create a project + mission in the web app and execute it via the CLI runner.
- A user can watch an executing objective update live in mission detail (no refresh).
- A user can review delivery summary, artifacts, and rationale coverage without the agent chat.
- A user can identify and clear stale execution requests.
- A user can configure connector/default-launch settings without editing config files.
- A core-only install hides every gated surface with no broken links and a fully usable core workflow.
- No screen performs or offers a git mutation; no repo content leaves the machine except an explicit attachment.

---

## 12. Process obligations

- Follow the [component-contract skill](../../.claude/skills/component-contract/SKILL.md)
  for every cross-module change; the contract update lands **before** the code.
- Ratify the §3.3 reads in the schema contract + `CONTRACT.md` first.
- DTOs derive from the logical schema's camelCase field names; validate with zod v4
  (zod-v4-patterns skill).
- REST handlers call the **shared service layer** only — never write tables directly,
  and never duplicate business logic the CLI/protocol already own.
- Colocate code and tests (`<area>/routes.ts` + `<area>/routes.test.ts` on the
  server; feature-colocated tests on the client).
- Keep `webapp/README.md` and `webapp/AGENTS.md` in sync as the module layout (§3.1)
  materializes.
