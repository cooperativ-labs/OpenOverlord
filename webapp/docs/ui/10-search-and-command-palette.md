# 10 — Search & Command Palette

Two related surfaces for fast navigation and action in a keyboard-first ops tool:
the **command palette** (`⌘K` / `Ctrl+K`) for jump-to and verbs, and the **search
results** page for ranked, filtered ticket search. Both honor the search capability
gate.

**Routes:** the palette is a global overlay (no route; opens over any screen);
results live at `/search?q=&status=&project=&…`.

---

## Command palette (`⌘K`)

A single overlay that blends navigation, entity jump, and actions — the fastest
path to anything.

```
┌─ ⌘K ──────────────────────────────────────────────────────────────────────┐
│ ⌕ build react…                                                             │
│ ─ Tickets ────────────────────────────────────────────────────────────────│
│   1:1429  Build Realtime React Web Interface        execute ●              │
│   1:1402  Seed schema                                complete               │
│ ─ Go to ──────────────────────────────────────────────────────────────────│
│   Board · Open0           Runner queue           Connectors                │
│   Project: Billing-svc    Settings → Tokens                                │
│ ─ Actions ────────────────────────────────────────────────────────────────│
│   + Create ticket…        ▷ Run focused objective   ↻ Run doctor           │
│   ⌫ Clear all execution requests                                           │
└────────────────────────────────────────────────────────────────────────────┘
   ↑↓ navigate · ↵ open · ⌘↵ run action · esc close
```

Result groups (ranked, deduped):

1. **Tickets** — by `display_id` (exact, always available) and, when Group 8 is
   installed, ranked text over title + first objective. Each shows live status.
2. **Go to** — navigation targets: board, runner, changes, connectors, settings,
   and **project switching** (type a project name to jump).
3. **Actions** — context-aware verbs that map to protocol/REST:
   - Create ticket (opens the create modal, doc 02)
   - Run the focused/selected objective (doc 04)
   - Answer the top blocking ask / approve a permission request (docs 03/07)
   - Clear all execution requests (doc 04)
   - Run doctor (doc 07)
   - Toggle theme/density

Behavior:

- Opens over any screen; preserves the underlying route. `esc` closes.
- Typing filters across all groups; the first result is preselected. `↵` opens,
  `⌘↵` invokes the action variant.
- Actions are RBAC-gated (Group 1): forbidden verbs are hidden or show the denial
  reason. Capability-gated targets (tokens, connectors health) only appear when
  their group is installed.

---

## Search results page (`/search`)

A full, filterable ranked search for when the palette isn't enough.

```
Search   [ q: rotation ]            scope: [ All projects ▾ ]
Filters: [ Status ▾ ] [ Project ▾ ] [ Creator ▾ ▸G1 ] [ Updated ▾ ]
┌──────────────────────────────────────────────────────────────────────────┐
│ 1:1421  Token rotation                review · Open0 · updated 12m         │
│   …rotate a USER_TOKEN and invalidate the old secret… (snippet, matched)   │
│ 1:1390  Rotate signing keys           complete · Infra · updated 3d        │
│   …key rotation schedule…                                                  │
└──────────────────────────────────────────────────────────────────────────┘
   matches over title, display_id, and first objective text · ranked
```

- **Matchable fields** (per the schema contract search requirements): exact
  `display_id` lookup; ranked text over title, display ID, and the first objective
  text; with snippets highlighting the match.
- **Filters**: workspace, project, status list, creator (gated G1), updated date
  range — mirroring the protocol `search-tickets` contract. All filter state in the
  URL so a search is shareable/reloadable.
- Results are bounded (sensible limit) and paginated; selecting a result opens
  ticket detail.

---

## Data + realtime

| Region | Read | Notes |
| --- | --- | --- |
| Ranked results | `GET /sync`?… no — `GET /tickets?q=` / a search endpoint over `search_documents` (Group 8) | with FTS5/`tsvector` under the hood; the UI uses the portable service interface |
| Exact lookup | `GET /tickets?displayId=` | always available, no Group 8 |
| Palette nav/actions | local route table + `['tickets']`/`['executionRequests']` caches | no extra fetch for nav/actions |

Search results reflect live status from the ticket cache/change feed (a result's
status badge updates if it changes while open), though re-ranking happens on the
next query, not continuously.

---

## States

- **Group 8 absent:** search degrades gracefully — `⌘K` and `/search` still do
  **exact `display_id` lookup** plus client-side filtering of already-loaded
  tickets; a subtle note explains that ranked full-text search needs the search
  capability. No broken UI.
- **No query:** palette shows recent tickets + top actions; results page shows
  recent/active tickets.
- **No matches:** "No tickets match" + offer to create a ticket with the query as
  the title.
- **Loading:** inline result skeletons; the palette stays responsive (debounced).

---

## Keyboard model (shared)

- `⌘K`/`Ctrl+K` open palette anywhere; `/` focuses search on the results page.
- `↑/↓` or `j/k` navigate; `↵` open; `⌘↵` action variant; `esc` close.
- These compose with the global shortcuts in doc 00 §8 (`c` create, `r` run focused
  objective, `?` help).

---

## Capability gating

- Ranked full-text search: Group 8 (`search_documents`); else exact + client filter.
- Creator filter and actor-scoped actions: Group 1.
- Palette actions are individually RBAC-gated and capability-gated to match the rest
  of the app.

---

## Acceptance criteria

- `⌘K` opens from any screen and can jump to a ticket by `display_id`, navigate to
  any primary surface, switch projects, and invoke context-appropriate actions.
- With Group 8 installed, search ranks over title, display ID, and first objective
  text with snippets and the documented filters, all reflected in the URL.
- With Group 8 absent, search still resolves exact `display_id` and filters loaded
  tickets, with no broken controls and a clear note about enabling full-text search.
- Palette actions respect RBAC and capability gates — forbidden/unavailable verbs do
  not appear or explain why.
</content>
