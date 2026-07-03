# Mission Data Webhooks / API

Proposal for letting external software react to mission activity — the canonical example being an
independently-hosted "feed post" generator like upstream Overlord's `generate-feed-post` edge
function, but equally a memory ingester, a production-test trigger, or any other automation. The
core requirement: **securely transfer structured mission information out of OpenOverlord, limited
by RBAC, on a webhook-like trigger** — without the consumer living inside this repository.

Status: proposal (mission coo:115). No implementation has started.

## 1. The Reference Use Case: Upstream Feed Posts

Upstream Overlord generates feed posts like this (reviewed from
`supabase/functions/generate-feed-post`, `lib/actions/feed.ts`, `lib/helpers/feed-post-rollup.ts`,
and `planning/feature-plans/feed-page-functionality.md`):

1. **Trigger**: after `POST /api/protocol/deliver`, `record-work`, an `update` that moves a ticket
  into review, or a manual objective completion, the backend fire-and-forgets an HTTP call to the
   edge function with `{ ticketId, organizationId, sessionId }`. Failures never block delivery.
2. **Context assembly**: the function reads (with service-role access) the ticket, its objectives,
  the project name, non-system ticket events for the session, file-change rationales, the agent
   session (agent + model identifiers), tickets spawned during the session, and per-project/user
   feed instructions.
3. **LLM digestion**: Gemini returns a structured JSON payload (title, summary, body, tags,
  impact level, tradeoffs, human actions, files touched, objective sections) with a deterministic
   fallback when the model is unavailable.
4. **Sink**: the result is upserted into `feed_posts` (deduped per ticket+session) and consumed by
  the feed UI over realtime.

The lesson for this feature: an external consumer needs (a) a **push trigger** at delivery time,
(b) **enough structured context** to feed an LLM without scraping, and (c) a **pull path** for
anything the push payload omits. Steps 3 and 4 are entirely the consumer's business — OpenOverlord
only needs to own the trigger and the data transfer.

## 2. What OpenOverlord Already Has (Research Findings)

The contract and codebase already reserve almost every seam this feature needs:

- `outbox_messages` **is contracted but unimplemented.** The schema contract
(`database/docs/09-database-schema-contract.md` → `outbox_messages`) defines a durable
side-effect queue — "notifications, webhooks, index updates" — with
`pending/processing/sent/failed/cancelled` statuses, `available_at`, `attempt_count`, and the
explicit guidance that hosted deployments should drive external delivery from it rather than
coupling domain tables to a broker. No migration creates it yet. **This feature is its natural
first consumer.**
- `entity_changes` **is the state-sync feed, not the effect feed.** The contract explicitly
separates the two ("the change feed is for state sync, while outbox messages are for effects").
A single writer (`insertEntityChange()` in `packages/core/service/change-feed.ts`) appends rows
transactionally with every domain mutation; `backend/realtime.ts` polls it every 500 ms and
fans out SSE. That poller is the proven in-process dispatch pattern the webhook dispatcher
should mirror.
- **The trigger point is a single choke point.** `deliverSession()` in
`packages/core/service/protocol.ts` runs one transaction that inserts the `deliveries` row, the
`mission_events` row (`type = 'delivery'`, a closed-vocabulary value), changed files, rationales,
and `entity_changes`. Status transitions likewise flow through shared service code. Enqueueing
webhook events inside these transactions guarantees at-least-once semantics with zero risk of
"delivered but never notified" or "notified but rolled back".
- **Two data layers write the same tables.** The REST backend (`backend/db.ts`/`repository.ts`)
and the protocol/CLI service core (`packages/core/service/*`) both mutate missions. Like
`insertEntityChange`, the webhook-enqueue helper must live in `packages/core` and be called from
both paths, or REST-originated deliveries would silently never fire webhooks.
- **RBAC gives the limiting mechanism.** Permissions are domain strings (`mission:read`,
`event:create`…) resolved through a config-backed provider (`openoverlord.rbac.toml`), checked
via `requirePermission` on every REST route. Permission names are an **open vocabulary** — new
`webhook:*` permissions need no contract version bump. `user_tokens` (with the new
`user_token_scopes` table) already confer a user's — optionally narrowed — permissions to
external callers, which covers the pull path.
- **Existing precedents to reuse**: `UserTokensPage.tsx` / `IntegrationsPage.tsx` settings UI
patterns; Everhour's workspace-settings secret storage (`backend/workspace-settings.ts`); the
automations layer's fire-and-forget non-fatal invocation pattern; `mission_events.source` and
`outbox_messages.topic` as open vocabularies.
- **Both editions must work.** Local (SQLite, loopback, often no public ingress *into* the
machine — but outbound webhooks work fine) and Cloud (Postgres, hosted). An in-process,
database-backed dispatcher works identically on both; no external queue is needed or wanted.

Why the existing extension points are *not* sufficient on their own:

- `OVERLORD_AUTOMATIONS_MODULE` runs custom automations **in-process** — good for forks, but the
mission explicitly asks for software independent of this repository/runtime.
- The SSE stream (`/api/stream`) is authenticated and RBAC-filtered but is a **thin state-sync
delta feed** — a consumer would have to hold a connection open, maintain cursors, and re-query
for context. That's a fine advanced option (and remains available via the pull API) but it is
not "a webhook that fires on delivery with the data you need".



## 3. Design Overview

Two complementary surfaces:

1. **Push — signed webhooks.** Workspace-scoped *webhook subscriptions* select events (v1
  centerpiece: `mission.delivered`), an optional project filter, and a payload mode. Matching
   events are enqueued to `outbox_messages` in the same transaction as the domain mutation and
   delivered by an in-process dispatcher as HMAC-signed HTTP POSTs with retries and a delivery
   log.
2. **Pull — the existing REST API with scoped tokens.** The payload carries hydration links
  (`/api/missions/:id`, `/api/missions/:id/events`, `/api/missions/:id/file-changes`, …). The
   consumer calls them with a normal `USER_TOKEN`, so everything it can read is bounded by RBAC
   exactly as for any other client. Push gets you the trigger and a snapshot; pull gets you
   everything else, always permission-checked at read time.



### 3.1 Event catalog (v1)

Namespaced, versioned event types (a **new** vocabulary — deliberately not reusing the closed
`mission_events.type` enum, so adding events never needs a contract version bump):


| Event type               | Fires when                                                              |
| ------------------------ | ----------------------------------------------------------------------- |
| `mission.delivered`      | `deliverSession()` commits (the feed-post trigger; also `record-work`)  |
| `mission.status_changed` | a mission moves between workspace statuses (includes → review/complete) |
| `objective.completed`    | an objective reaches `complete` (incl. manual completion)               |
| `mission.blocked`        | an agent posts an `ask` (lets consumers page a human)                   |


Future candidates (explicitly out of v1): `mission.created`, `session.started`,
`execution_request.queued`, `artifact.created`. The envelope carries `apiVersion` so payload
evolution is possible without breaking consumers.

### 3.2 Payload envelope

One JSON envelope for all events; `data` varies by type. For `mission.delivered` in `full` mode it
carries what the upstream feed generator reads, so a consumer can build a feed post from the
webhook body alone:

```jsonc
{
  "id": "whd_9f2c…",                    // unique delivery id (idempotency key for consumers)
  "apiVersion": "2026-07-01",
  "type": "mission.delivered",
  "occurredAt": "2026-07-02T18:04:11Z",
  "workspace": { "id": "…", "name": "Cooperativ" },
  "project": { "id": "…", "name": "OpenOverlord", "color": "#4f46e5" },
  "mission": {
    "id": "…", "displayId": "coo:115", "title": "Develop Mission Data Webhooks/API",
    "status": { "id": "…", "type": "review", "label": "In review" },
    "priority": "normal", "createdAt": "…"
  },
  "objective": { "id": "…", "position": 0, "title": "…", "state": "complete" },
  "session": { "id": "…", "agentIdentifier": "claude-code", "modelIdentifier": "claude-fable-5" },
  "delivery": {
    "id": "…", "summary": "…", "verificationSummary": null, "followUpNotes": null,
    "artifacts": [{ "type": "next_steps", "label": "…", "content": "…" }]
  },
  "changedFiles": [{ "filePath": "lib/api.ts", "vcsStatus": "modified" }],
  "changeRationales": [{ "filePath": "lib/api.ts", "label": "…", "summary": "…", "why": "…", "impact": "…" }],
  "missionEvents": [{ "id": "…", "type": "update", "summary": "…", "createdAt": "…" }],
  "spawnedMissions": [{ "id": "…", "displayId": "coo:118", "title": "…" }],
  "links": {
    "mission": "/api/missions/6f0fc5b0…",
    "events": "/api/missions/6f0fc5b0…/events",
    "fileChanges": "/api/missions/6f0fc5b0…/file-changes",
    "artifacts": "/api/missions/6f0fc5b0…/artifacts"
  }
}
```

Two **payload modes** per subscription:

- `thin` — envelope + ids + `links` only. The default for **external** endpoints: mission content
never rests on a third-party endpoint unless the consumer pulls it with a valid token.
- `full` — the snapshot above, size-capped (~256 KB; long arrays truncated with a
`"truncated": true` marker, `links` always present for the rest). The recommended (and
UI-pre-selected) mode for **internal** endpoints — see below.

Which mode fits is a trust-in-the-endpoint question, not an RBAC question: `full` payloads are
hydrated through the subscription owner's permissions either way (Section 3.3), so thin vs full
only decides *where the owner's view of the data comes to rest*, not how much of it exists.

**Internal (colocated) endpoints.** Many real consumers run next to the backend — another service
in the same Railway project reached over the private mesh (`http://feed-gen.railway.internal`), or
a localhost process in Local edition. For these the thin-mode rationale disappears (the payload
never leaves the deployment's own network) while its costs remain (N pull round-trips plus token
provisioning per event). The instance operator declares which hosts are internal via
`OVERLORD_WEBHOOK_INTERNAL_HOSTS` — a comma-separated list of host suffixes, e.g.
`*.railway.internal`; Local edition implicitly includes `localhost`/`127.0.0.1`. An endpoint
matching the list is treated as internal: exempt from the SSRF private-network block, allowed to
use plain `http://` (Railway's private mesh is unencrypted HTTP), and pre-selected as `full` in
the UI. This is an env var rather than a workspace setting deliberately — which services share a
private network is deployment topology, an operator fact, and keeping it out of the database means
a compromised admin account cannot re-label an external host as "internal". `full` remains
selectable for external endpoints behind a UI warning (an admin pointing at their own VPS is a
legitimate, consciously-taken risk — still TLS + HMAC-signed); it is de-defaulted, not forbidden.

Payloads pass through the existing secret-redaction path before storage/dispatch — the contract
already requires `outbox_messages.payload_json` to be secret-redacted.

### 3.3 Security model

- **RBAC at both edges.**
  - *Managing* subscriptions requires new open-vocabulary permissions `webhook:create`,
  `webhook:read`, `webhook:update`, `webhook:delete` — granted to `ADMIN` by default in
  `openoverlord.rbac.toml` (instances can extend `MEMBER`).
  - *Payloads are actor-bound.* Each subscription records `created_by_workspace_user_id`. At
  enqueue/dispatch time the payload builder resolves that actor and reads through the same
  service functions REST uses, so it sees exactly what its owner may see (`mission:read`,
  project membership, workspace scoping). If the owner loses membership or the permission, the
  event is skipped and logged, and the subscription auto-disables after a threshold. A
  subscription can never out-read its creator.
  - *Pull path* is ordinary token auth: `user_tokens` + `user_token_scopes`, evaluated per
  request. Recommended pattern for consumers: a service-kind MEMBER user with a scoped token.
- **Signing.** Per-subscription secret (`whsec_…`, generated server-side, revealed at creation
and on explicit rotation). Every request carries Stripe-style headers:
`X-Overlord-Signature: t=<unix-ts>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>`, plus
`X-Overlord-Event`, `X-Overlord-Delivery`, `X-Overlord-Workspace`. The timestamp bounds replay
(consumers reject |now − t| > 5 min); the delivery id makes retries idempotent. The secret must
be stored raw (HMAC needs it) — same posture as the Everhour key today; a follow-up can add
at-rest envelope encryption keyed by an instance env secret for both.
- **SSRF.** External endpoint URLs must be `https://`, and loopback/RFC-1918/link-local/private-
IPv6 targets are rejected at save *and* at dispatch (resolve DNS, then connect to the validated
IP — a blanket private-IP block would otherwise reject exactly the colocated consumers we want
to support, since Railway's private mesh resolves to private IPv6 addresses). Endpoints matching
`OVERLORD_WEBHOOK_INTERNAL_HOSTS` (Section 3.2) are exempt from the block and from the https
requirement; in Local mode `localhost` is implicitly internal — the server already runs on the
user's machine and local consumers are a primary use case.
- **Reliability semantics.** At-least-once, per-subscription best-effort ordering, no guaranteed
global order. Consumers dedupe on `id`.



## 4. Backend Implementation Plan



### Phase 0 — Contract update (must land first, per contract rules)

- Add `webhook_subscriptions` and `webhook_delivery_attempts` to
`database/docs/09-database-schema-contract.md`; mark `outbox_messages` as implemented.
- Declare open-vocab values: `outbox_messages.topic = 'webhook.deliver.v1'`, RBAC `webhook:*`
permission names, and the webhook event-type list (new vocabulary, documented as open).
- Add the new REST endpoints to the REST section; note the dispatcher as an internal REST-layer
worker (like `RealtimeHub`). Webhook enqueue helper joins `insertEntityChange` as a
shared-single-writer rule in the Protocol → Database surface.
- No closed vocabularies change and no existing interface breaks, but new tables/endpoints mean a
contract **version bump** with changelog entry, mirrored in `contract/components.yaml` /
`extension-points.yaml`.



### Phase 1 — Schema (SQLite + Postgres migrations, kysely types, both data layers)

```sql
CREATE TABLE outbox_messages (        -- exactly as already contracted
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  topic TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  available_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- indexes: (workspace_id, status, available_at); (topic, created_at)

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),          -- NULL = all projects in workspace
  name TEXT NOT NULL, endpoint_url TEXT NOT NULL,
  secret TEXT NOT NULL,                             -- whsec_…, raw for HMAC
  event_types_json TEXT NOT NULL,                   -- ["mission.delivered", …]
  payload_mode TEXT NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin','full')),
  created_by_workspace_user_id TEXT NOT NULL REFERENCES workspace_users(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,                             -- 'manual' | 'failures' | 'owner_revoked'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT, last_failure_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE webhook_delivery_attempts (            -- per-attempt log for the UI
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  outbox_message_id TEXT NOT NULL REFERENCES outbox_messages(id),
  event_type TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  response_status INTEGER, response_snippet TEXT,   -- first ~1KB, redacted
  error TEXT, duration_ms INTEGER, attempted_at TEXT NOT NULL
);
```

One outbox row per **(event × matching subscription)** (topic `webhook.deliver.v1`, payload =
`{subscriptionId, eventType, envelope}`), so per-subscription retry state is just the row's
`status/available_at/attempt_count` — no fan-out bookkeeping. Mutations to `webhook_subscriptions`
emit `entity_changes` rows like every other domain table so the management UI updates in realtime.

### Phase 2 — Enqueue in the service core

- New `packages/core/service/webhook-events.ts`, mirroring `change-feed.ts`: a single
`enqueueWebhookEvent(tx, { workspaceId, projectId, type, buildEnvelope })` that matches active
subscriptions (workspace + project filter + event type + enabled + owner still a member) and
inserts outbox rows **inside the caller's transaction**.
- Call sites: `deliverSession()` (→ `mission.delivered`), `record-work`, mission status-change
service functions (→ `mission.status_changed`), objective completion, `ask` (→
`mission.blocked`) — in **both** data layers, same as the `insertEntityChange` discipline.
- Envelope assembly is actor-bound (Section 3.3) and reuses existing read helpers; keep it
non-fatal-by-design: enqueue happens transactionally (cheap inserts), heavy reads for `full`
payloads happen in the dispatcher, not in the delivery transaction, so delivery latency is
unaffected and payload-build failures can never roll back a delivery.



### Phase 3 — Dispatcher (`backend/webhook-dispatcher.ts`)

- Singleton loop modeled on `RealtimeHub`: every ~1 s (and via a `pollNow()` nudge from enqueue
sites), atomically claim due rows — `UPDATE … SET status='processing' WHERE id IN (SELECT … WHERE status='pending' AND available_at <= now LIMIT n)` CAS works on SQLite and Postgres.
- For each claim: build/load the envelope (thin: from stored payload; full: hydrate as the owner
actor at dispatch time so data is fresh and permission-checked), sign, POST with a 10 s timeout,
≤1 redirect disallowed, record a `webhook_delivery_attempts` row.
- 2xx → `sent`; else backoff schedule `30s, 2m, 10m, 1h, 6h, 24h` via `available_at`, then
`failed`. Subscription `consecutive_failures ≥ 20` → auto-disable (`disabled_reason='failures'`)
and surface a system notification. Startup requeues stale `processing` rows (crash recovery).
- Env switches: `OVERLORD_WEBHOOKS_DISABLED=1` (ops off-switch),
`OVERLORD_WEBHOOK_INTERNAL_HOSTS` (comma-separated host suffixes treated as internal — SSRF
exemption, plain-http allowed, `full` trusted; `localhost` implicit in Local edition).



### Phase 4 — Management REST API

All workspace-scoped, `requirePermission(webhook:*)`, mutating routes emit `entity_changes`:


| Route                                                   | Action                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET/POST /api/webhooks`                                | list / create (response includes the secret **once**)                   |
| `PATCH/DELETE /api/webhooks/:id`                        | update (name, url, events, project, mode, enable/disable) / soft-delete |
| `POST /api/webhooks/:id/rotate-secret`                  | new `whsec_…`, returned once                                            |
| `POST /api/webhooks/:id/test`                           | enqueue a synthetic `webhook.ping` delivery to the endpoint             |
| `GET /api/webhooks/:id/deliveries`                      | paginated attempt log (joined outbox + attempts)                        |
| `POST /api/webhooks/:id/deliveries/:outboxId/redeliver` | reset row to `pending`, `available_at = now`                            |




### Phase 5 — Docs, example consumer, drift surfaces

- `docs/webhooks.md`: event catalog, envelope schema, signature-verification snippet
(10-line Node example), retry semantics, thin-vs-full guidance, pull-API pattern with scoped
tokens.
- Example consumer under `docs/` or a sample repo: a ~100-line Express service that verifies the
signature, hydrates via `links` with a scoped token, calls an LLM, and posts a feed entry —
i.e., the upstream feed-post pipeline rebuilt out-of-repo, proving the mission's goal.
- Update drift-review surfaces (CLI README/API docs) and, optionally later, `ovld webhooks list`
CLI parity.

Rough sequencing/estimate: Phases 0–1 one PR, 2–3 one PR (the meat), 4 one PR, 5 + UI in parallel.

## 5. Management Interface Proposal

A new **Webhooks** page in workspace settings (`webapp/web/components/settings/WebhooksPage.tsx`),
sitting beside **Integrations** and **User Tokens** and following their list-plus-dialog idiom.
Admin-gated via the same permission the API enforces.

**List view** — one row per subscription:

- Name, endpoint host (full URL on hover), project chip (or "All projects"), event-type chips.
- Status pill: `Active` / `Disabled` / `Failing` (amber once `consecutive_failures > 0`, red when
auto-disabled) + relative "last delivery" time and its response code.
- Row actions: enable/disable toggle, **Send test**, edit, delete. Realtime-updated via the
existing `entity_changes` SSE plumbing.

**Create / edit dialog**:

- Name; endpoint URL (client-side + server-side validation; https-required notice for external
hosts, and an **Internal** badge when the host matches `OVERLORD_WEBHOOK_INTERNAL_HOSTS`);
project selector (reuses `MissionProjectSelect`-style component); event-type checkbox group with
one-line descriptions; payload mode radio — pre-selects `full` for internal endpoints and `thin`
for external ones, with a one-line warning when `full` is chosen for a non-internal host.
- On create: secret revealed once in a copy field with the standard "you won't see this again"
treatment (same UX as token creation), plus a "Send test delivery" button right in the success
state so users can verify wiring before leaving the dialog.

**Delivery log drawer** (opens from a row): reverse-chronological attempts — event type, time,
attempt number, response status, duration; expanding an entry shows the (redacted) payload and
response snippet; per-entry **Redeliver** button; header actions for **Rotate secret** and
**Copy signing docs link**.

**Failure surfacing**: when a subscription auto-disables, emit a system notification (existing
`system-notifications` component) linking straight to the delivery log.

## 6. Alternatives Considered

- **Let consumers poll** `/api/stream` **(SSE) or** `entity_changes` **cursors.** Already possible with a
token and stays available, but inverts the integration burden (connection management, cursors,
re-hydration) and the contract reserves the change feed for state sync, not effects. Rejected as
the primary surface; kept as an advanced pull option.
- **In-process custom automations (**`OVERLORD_AUTOMATIONS_MODULE`**).** Right tool for forks, wrong
tool for "independent software"; requires shipping code into the Overlord runtime and can't be
managed per-workspace by non-operators. Rejected for this goal.
- **Dispatch directly from the delivery transaction (no outbox).** Simpler, but couples delivery
latency to third-party endpoints and loses retries/crash-safety. Rejected — and the contract
already prescribes the outbox.
- **External queue/broker.** Overkill for both editions; the contract explicitly says to start
database-backed and drive any future broker *from* `outbox_messages`. Deferred.
- **Reusing** `mission_events.type` **as the event vocabulary.** It's a closed enum requiring a
contract bump per addition; a separate namespaced event catalog evolves freely. Rejected.



## 7. Contract Impact Summary


| Change                                                          | Impact                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Implement `outbox_messages`                                     | Already specified; mark as shipped, no interface change                                         |
| New tables `webhook_subscriptions`, `webhook_delivery_attempts` | Schema contract additions → **contract version bump**                                           |
| New topic `webhook.deliver.v1`                                  | Open vocabulary — declare, no bump                                                              |
| New `webhook:*` permissions                                     | Open vocabulary (RBAC names) — declare + default-role config change                             |
| New `/api/webhooks*` routes                                     | REST-layer additions → documented in REST section, version bump covered above                   |
| Webhook event-type catalog                                      | New open vocabulary owned by REST/service layer                                                 |
| Enqueue helper in `packages/core`                               | New shared-single-writer rule alongside `insertEntityChange` (Protocol → Database surface note) |


No closed vocabulary changes; no breaking changes to any existing surface; Local edition behavior
is purely additive (dispatcher idles when no subscriptions exist).

## 8. Decisions And Open Questions

Resolved (PM, 2026-07-03):

1. **Default management permission** — ADMIN-only.
2. **Payload mode defaults** — `thin` for external endpoints, `full` for internal endpoints
   declared via `OVERLORD_WEBHOOK_INTERNAL_HOSTS` (Sections 3.2/3.3); `full` stays selectable
   externally behind a warning.

Still open (for PM):

3. **v1 event list** — is `mission.delivered` + `mission.status_changed` enough to ship, with
   `objective.completed`/`mission.blocked` fast-follow?
4. **Consumer auth story** — should we add a first-class "service user + scoped token" creation
   flow in the same UI, so setting up a consumer is one screen instead of two?

