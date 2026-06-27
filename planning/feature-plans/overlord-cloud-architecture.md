# Overlord Cloud Architecture

Date: 2026-06-25

## Overview

**Overlord Cloud** is a hosted edition of Overlord offered *alongside* the
existing local-only edition. It is not a replacement.

- **Overlord Local (today):** Electron desktop app supervises a loopback
  backend over SQLite on the user's machine. Everything runs on one device. No
  account or network dependency required.
- **Overlord Cloud (this document):** the backend and database run in the
  cloud as a shared control plane; the desktop app, the web app, the CLI, and
  one or more execution targets (runners) all connect to that backend over
  HTTPS. The same product, the same contract, just with the system of record
  hosted instead of local.

Both editions speak the same REST + protocol + realtime contract, so the
desktop app and CLI are the same binaries in either mode — only the configured
`backend_url` and auth differ.

### Provider decisions (the conclusions)

| Concern | Choice | One-line reason |
| --- | --- | --- |
| Backend / API service | **Railway** | Always-on container host; good at long-lived services, queues, and streams. |
| Database (system of record) | **Railway Postgres first; Neon later** | Start with one-provider EU deployment and private networking; keep Neon as the managed Postgres migration target when HA/PITR/branching justify it. |
| Web frontend | **Vercel** | Global edge delivery, instant deploys, preview-per-PR. |
| Desktop frontend | **Electron + bundled webapp** | Offline-capable, instant launch, safe native bridge, version-coherent with the local CLI. |

## Topology

```text
                         ┌─────────────────────────────┐
  Web users  ───────────▶│  Vercel  (web frontend)     │
                         │  SSR/edge, region: fra1      │
                         └──────────────┬──────────────┘
                                        │ HTTPS REST + SSE/realtime
                                        ▼
  Desktop users ──────────────▶┌──────────────────────────────┐
  (Electron, bundled webapp)    │  Railway backend service      │
  HTTPS REST + SSE/realtime     │  REST + protocol + /realtime  │
                                │  + runner queue, EU West      │
                                └───────────────┬──────────────┘
                                                │ service-layer transactions
                                                ▼
                                ┌──────────────────────────────┐
                                │  Railway Postgres (phase 1)   │
                                │  EU West / private network    │
                                └──────────────────────────────┘

  Execution targets (laptop, home server, cloud runner)
        │  outbound HTTPS poll / long-poll / SSE  (no inbound port)
        ▼
  ovld runner service → local worktree → local agent → ovld protocol deliver
```

The unifying principle from the prior architecture work still holds: **runners
are local executors; the backend is the single state authority; desktop and web
are clients.** Overlord Cloud just hosts the state authority and database in the
cloud instead of on the user's machine.

## Provider Decisions In Detail

### Backend → Railway

Host the Overlord backend/API as an always-on Railway service (containers
deployable from GitHub, a directory, or a Docker image). The backend owns the
shared concerns:

- auth and RBAC;
- execution-request queueing, claiming, expiry, and stale-launch recovery;
- target and project-resource records;
- protocol writeback (`attach → update/heartbeat → ask/deliver`);
- the realtime feed (`entity_changes` + `/realtime` stream + `/sync/changes`);
- database migrations and adapter selection.

Railway is the right fit specifically because the backend needs to hold
**long-lived connections** — the `/realtime` SSE stream and the runner
claim/long-poll loop — and run background workers. That is always-on-service
territory, not serverless-function territory (see the Vercel section).

Pin the Railway service to **EU West (Amsterdam)** to co-locate with the phase-1
Railway Postgres database and stay close to the phase-2 Neon EU target (see
Region & Latency).

### Database → Railway Postgres first, Neon later

The first production deployment uses Railway Postgres in the same Railway
project and EU West region as the backend. This keeps the initial hosted control
plane operationally simple: one provider, private networking for the backend DB
URL, co-located compute/database, and no Neon scale-to-zero behavior on the hot
path.

Provisioned phase-1 state:

- Project: `overlord-cloud` (`16825060-9441-490c-ab61-fc4e50ed9686`)
- Backend service: `overlord-backend`
  (`71f225e9-8dff-4348-95d5-f3d7f2f02e2b`)
- Postgres service: `Postgres` (`4b1dc026-76bd-46d8-a723-bf9026df5aa6`)
- Region: EU West (`europe-west4-drams3a`)
- Backend DB variable: `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  (private Railway hostname, not the public TCP proxy)

Accept the tradeoff explicitly: Railway Postgres is a Postgres service on a
Railway volume, not a managed HA database product. Before live use, native
Railway backups must be scheduled from the service Backups tab and the logical
`pg_dump`/`pg_restore` restore procedure must stay rehearsed. The 2026-06-27
bootstrap applied 12 migrations, produced 41 public base tables, verified
`max_connections=100`, set backend `statement_timeout=30s`, and restored a
custom-format dump into a temporary rehearsal database.

### Database → Neon migration target

Use Neon as the later managed Postgres system-of-record target. It is managed
serverless Postgres with autoscaling, scale-to-zero, branching,
instant/point-in-time restore, and PgBouncer-based connection pooling.

Neon remains the phase-2 target when managed database features outweigh the
single-provider simplicity. Railway Postgres and Neon are different categories of
product. Railway Postgres is an unmanaged Postgres container on a volume; with
Neon, HA, PITR, autoscaling, pooling, and branching are provider features. The
database is the one component we least want to hand-operate long term, because:

1. **It is the system of record.** Every client, runner, and protocol event
   depends on it. A single-container Postgres on a volume is a single point of
   failure with redeploy downtime. Managed HA/backups/PITR is worth not owning.
2. **Volume coupling limits the backend.** A Railway volume is single-instance
   (one per service, no replicas, brief redeploy downtime), so a volume-backed
   Postgres can't scale out and forces backend-adjacent downtime. Neon decouples
   storage from compute, so the backend redeploys and scales freely.
3. **Branching is a real workflow win** — cheap copy-on-write clones for
   staging, preview deploys, and migration rehearsal.
4. **Connection scaling** — Neon ships pooling we'd otherwise stand up and tune
   ourselves once many desktop/web/CLI/runner sessions hit the backend.
5. **The split is cheap.** The backend reaches the DB over an outbound
   connection string regardless of provider, so two providers means one extra
   account and one extra secret — not added architectural complexity.

Production guidance for a Neon cutover: the backend owns DB credentials; clients
never connect to Neon directly. **Disable Neon autosuspend (scale-to-zero) on the
production database** so the hot path never pays a cold-start; reserve
scale-to-zero for dev/preview branches. Do not couple realtime to Postgres
`LISTEN/NOTIFY` on the pooled path — keep the portable `entity_changes` feed
canonical.

### Web frontend → Vercel

Serve the web app (`webapp/web`) from Vercel: global CDN/edge, instant deploys,
and preview deployments per PR. The browser holds its realtime connection
**directly to the Railway backend**, not proxied through Vercel, so Vercel
serving the shell adds zero latency to data freshness.

**Keep the backend off Vercel functions.** Vercel serverless functions are
short-lived and fight the three things Overlord needs:

- the persistent `/realtime` stream (WebSockets unsupported on Vercel
  functions; SSE capped by function max-duration);
- the runner claim/long-poll loop (per-invocation, duration-capped);
- `LISTEN/NOTIFY` listeners and background workers (can't hold a persistent
  connection).

So Vercel is **additive** (a better way to deliver the web UI), not a
replacement for the always-on Railway backend — which the desktop app and
CLI/runners need to exist regardless.

If any DB-touching SSR/route handlers run on Vercel during phase 1, pin them to
`fra1`, use the Node runtime (not Edge), and keep them behind the backend/service
contract rather than opening client-direct database surfaces. A later Neon
cutover can revisit Neon's pooler/serverless driver for many short-lived
function instances, but the first deployment keeps the database behind the
Railway backend.

### Desktop frontend → Electron with the bundled webapp

Two options were considered for the desktop app: (A) bundle the webapp into the
Electron app, as today, or (B) make Electron a thin wrapper that loads the
Vercel-served URL. **Bundle it (A).**

The key insight: live *data* ≠ live *UI shell*. The data, missions, and realtime
updates come from the Railway backend over the network in both cases. Whether
the HTML/JS/CSS shell loads from disk or from Vercel changes nothing about data
freshness. The wrapper's only real benefit is shipping frontend *code* changes
without an app release — which auto-update largely provides anyway.

Bundling wins here because:

1. **Offline / local-only / home-server mode survives.** The desktop app can
   point at a local loopback backend (Overlord Local) or a home-server backend.
   If the UI shell itself had to be fetched from Vercel, the app wouldn't open
   offline. Bundled assets always render.
2. **Instant launch, no Vercel dependency** to open the app.
3. **Security.** The desktop renderer is privileged (holds `OVERLORD_USER_TOKEN`,
   talks to the local runner/CLI, touches the filesystem). Electron guidance is
   to *not* load remote content into a renderer with a preload/IPC bridge. A
   local origin keeps that bridge safe.
4. **Version coherence** with the native/IPC contract and the bundled `ovld`
   CLI; a remotely-served frontend can drift ahead and break the bridge.

Keep update speed without the wrapper via **one codebase, two delivery
channels**: `webapp/web` builds once; Vercel gets the web deploy, the desktop
gets the same bundle. Ship frontend changes to desktop via auto-update
(electron-updater). Only if iteration speed becomes a real pain should you add a
staged-asset loader (bundled assets by default, optional pull of a newer
*compatible* bundle on launch, version-gated, with the bundled copy as offline
fallback).

Build-mode note: the desktop frontend runs as a **client-side SPA** hitting the
Railway API (no Next SSR server in the app). Keep control-surface views
client-renderable so they bundle cleanly; reserve Vercel SSR/server components
for public/marketing/SEO pages the desktop app doesn't need.

## Desktop App: Switching Between Backends (Local ↔ Cloud)

The CLI already targets either edition by changing `backend_url`. The desktop
app cannot, because today it fuses three things into one value:

- `main.ts` computes a single `appOrigin` once at boot
  (`http://127.0.0.1:<freeport>`), forks an embedded server (`server.ts`,
  `startServer`) that serves **both** the bundled SPA and the REST API on that
  loopback port, then loads `${appOrigin}/` into the window.
- `window.ts` hardcodes that single origin everywhere: CSP `connect-src 'self'
  ${appOrigin} ${wsOrigin}` (`applyCsp`) and the navigation guard
  (`guardNavigation`).
- The SPA assumes its API is same-origin (`'self'`).

So the desktop app's baked-in assumption is **renderer origin == API origin ==
local loopback**. Cloud mode breaks that: the SPA shell still loads from a local
origin (we bundle it — see the desktop decision above), but its API/realtime
calls must go cross-origin to the remote Railway backend, which also has its own
login. Repointing therefore can't be a simple URL swap; it's a reload + re-auth.

### Changes required

1. **Backend profiles.** Persist a list of backend profiles (in
   `settings-store.ts`'s `userData/settings.json`, keyed alongside the existing
   `overlord.toml` `backend_mode`/`backend_url`). Each profile:
   `{ id, label, mode: 'local' | 'remote', backendUrl }` — e.g. a built-in
   "Local" profile and one or more "Overlord Cloud" / self-hosted remote
   profiles. Track the active profile id.

2. **Decouple renderer origin from API origin.** Keep loading the **bundled**
   SPA from a local origin (preserves the "never load remote content into a
   privileged renderer" rule from the desktop decision), but inject a separate
   **API base URL** for the active profile:
   - *Local profile:* fork the embedded server as today; API base = the loopback
     origin (unchanged behavior).
   - *Remote profile:* **do not** fork the embedded server; serve the bundled SPA
     from a minimal local static origin (or `file://`) and set its API base to
     the remote backend URL.
   This requires a **webapp contract change**: the SPA's API/realtime client must
   accept a runtime-injected base URL instead of assuming same-origin. The web
   (Vercel) build keeps same-origin/env-based configuration.

3. **Expose backend config to the renderer.** Extend the preload bridge
   (`window.overlord`) and `ipc.ts` with `getActiveBackend()`,
   `listBackends()`, `addBackend()`, `removeBackend()`, and
   `switchBackend(id)`. The SPA reads the active backend URL + mode from this
   bridge to configure its API client.

4. **Recompute origin-scoped policy on switch.** `applyCsp` and
   `guardNavigation` must become functions of the active profile, not boot-time
   constants:
   - add the remote backend origin and its `wss://` to `connect-src`;
   - re-register `onHeadersReceived` against the active session/partition;
   - keep navigation scoped to the shell origin so external/auth links still
     open in the system browser.
   `waitForHealth` also needs HTTPS support (it is `http`-only today) to ping a
   remote `/api/health`, with a clear "can't reach Overlord Cloud" retry dialog
   (mirroring the existing `showStartupError` flow) and an offer to fall back to
   Local.

5. **Per-backend session isolation + reload-and-login flow.** Because each
   backend has independent credentials, load the window under a **per-profile
   Electron session partition** (`session.fromPartition('persist:backend-<id>')`).
   Switching backends then:
   1. clears in-memory renderer state for the old backend;
   2. stops the embedded server if leaving Local; starts it if entering Local;
   3. recomputes `appOrigin` + API base + CSP + nav guard for the new profile;
   4. reloads the window under the new profile's partition.

   The SPA boots, finds no valid session in that partition, and shows login. With
   persistent per-backend partitions, the user logs in **once per backend** (not
   on every switch) until that backend's session expires — which matches the
   user's expectation that repointing involves a reload and a login.

6. **Auth tokens: prefer bearer over cross-site cookies.** Since the shell origin
   (local) and the remote API origin differ, better-auth cookie sessions would be
   cross-site (SameSite=None;Secure pain). Cleaner: the desktop remote mode
   obtains a **bearer token** at login, stored per-backend in the OS keychain via
   Electron `safeStorage`, injected into the SPA's API client and into any
   `ovld` process the app spawns. This unifies with the CLI's existing
   `USER_TOKEN` model and sidesteps cross-origin cookies. Spawned-CLI IPC must use
   the **active profile's** `backendUrl` + token, not the local defaults.
   OAuth/browser-redirect logins should round-trip via a custom protocol
   (`overlord://`) or loopback callback and land in the correct partition.

7. **Switcher UI + first-run.** Add a backend switcher (app menu and/or settings)
   showing the active backend, its connection status, and "Add backend…". A
   first-run chooser ("Use Local" vs "Sign in to Overlord Cloud") sets the
   initial profile. Don't fork the embedded server at all in remote mode.

### Contract impact

This is a **Desktop Shell contract change**: the current contract specifies a
loopback shell that supervises a local server on a single origin. The remote
mode adds: configurable `backend_url`, a separate-origin API, per-backend session
partitions, bearer-token auth via `safeStorage`, no forked server in remote mode,
and a CSP `connect-src` that includes the remote origin. The companion
**webapp contract change** is the runtime-injected API base URL. Specify both in
`CONTRACT.md` before code (this expands point 6 of "Contract Changes Needed").

## Authentication

**Decision: keep self-hosted Better Auth as the single auth layer; do not adopt
Neon Auth.**

Overlord already runs Better Auth (`desktop/sqlite/migrations/001_better_auth.sql`)
wired into RBAC (`003_rbac.sql`) and the scoped-token model. Neon Auth is itself
a managed, Neon-hosted flavor of Better Auth, so adopting it would mean
migrating a working setup to a hosted version of the same library — while adding
constraints:

- **It breaks edition parity.** Neon Auth is cloud-only and tied to Neon
  infrastructure; the Local edition runs SQLite with no Neon. Adopting it forks
  auth into self-hosted (Local) and Neon-hosted (Cloud), contradicting the
  "same binaries, same contract, just a different `backend_url`" principle.
- **It doesn't cover the hard part.** Runners, the CLI, and the desktop
  multi-backend flow authenticate with non-interactive **bearer/service tokens**
  scoped to `mission_lifecycle`/target. That machine-token layer is custom to
  Overlord and stays our responsibility regardless of Neon Auth.
- **It couples identity to the DB vendor**, undermining provider portability
  (e.g. the Railway-Postgres fallback would also lose its auth layer).
- **Migration + lock-in cost** for existing users/sessions/RBAC tables, in
  exchange for a managed version of software we already run.

The auth model for both editions:

- **Interactive users** (desktop, web) authenticate via Better Auth, owned by
  the backend, behaving identically in Local and Cloud.
- **Machine clients** (CLI, runners, spawned agents) use bearer/service tokens
  (`USER_TOKEN`, scoped service tokens) issued and rotated by the backend.
- **Desktop remote mode** stores a per-backend bearer token in the OS keychain
  via `safeStorage` (see "Desktop App: Switching Between Backends").
- If social login is wanted, add OAuth providers to Better Auth rather than
  introducing a second identity system.

Neon Auth would only have been the right call for a greenfield, cloud-only
product. Overlord is neither, so it is a complication, not a simplification. Its
one genuinely nice feature — auth state that branches alongside Neon DB branches
— can be approximated by seeding test users per branch when needed.

## Region & Latency

The database provider choice adds latency only on the **backend↔DB** leg, not
the user↔UI leg. Co-location is the dominant lever:

| Pairing | Backend↔DB RTT | 3 sequential queries |
| --- | --- | --- |
| Co-located, same metro | ~1–5 ms | ~5–15 ms (negligible) |
| Cross-region, same continent | ~25–70 ms | ~75–210 ms (noticeable) |
| Cross-continent | ~100–250 ms | sluggish |

Phase-1 pairing: **Railway EU West (Amsterdam) + Railway Postgres EU West** in
the same project over private networking. Phase-2 Neon pairing: Railway EU West
+ Neon `aws-eu-central-1` (Frankfurt), both in the EU. Avoid cross-continent
pairings.

What actually makes the UI feel slow (none are the provider split itself):

- **Not co-locating** — keep backend and database in the same Railway EU West
  project for phase 1, or the closest EU pairing for phase 2.
- **Cold connections** — a cross-DC TLS+auth handshake costs 50–100 ms+. Use a
  warm pooled connection and reuse it.
- **Neon scale-to-zero cold starts** — disable autosuspend on the prod DB.
- **Sequential query chains / N+1** — collapse into single-round-trip
  transactions, CTEs, or pipelining.
- **Poll vs push realtime** — use the `/realtime` push stream, not
  `/sync/changes` polling, so propagation is bounded by backend→client.

Make the UI feel instant regardless of network with **optimistic UI**: apply the
change locally on user action, send to the backend, and reconcile when the
authoritative `entity_changes` event returns. The realtime event should be
emitted by the backend immediately after commit (from data already in memory),
so the cross-DC hop stays off the fan-out path.

## Execution Plane

Install the CLI on every execution target; do not install a full app on each
target. The CLI already owns the machine-local concerns (device/target identity,
checkout discovery, connector install/repair, branch/worktree prep, local
command spawning, headless execution, protocol attach/update/deliver). A remote
target is a *client* of the system, not a partial authority over the database.

Every target implements the same runner contract:

1. Target registers with the backend and receives a stable
   `execution_target_id`.
2. Target heartbeats with type, label, capabilities, health, and active
   resources.
3. User links one or more project resources to that target.
4. User queues an objective to a selected target.
5. Runner claims a compatible request atomically through the backend.
6. Runner resolves the target-local path, prepares branch/worktree, launches the
   agent, and sends protocol updates back.

Target types:

- `local` — laptop or workstation runner (also the Overlord Local default).
- `cloud_persistent` — long-lived cloud runner with a durable filesystem.
- `cloud_sandbox` — provisioned, possibly just-in-time sandbox (e.g. Daytona).
- `ssh` — future bring-your-own remote host.

### What to build

1. **Runner service mode in the CLI** — `ovld runner install-service`,
   `uninstall-service`, `logs`, and a hardened `start` loop for `systemd`,
   `launchd`, or containers. Remote targets default to headless launch.
2. **Headless launch profile** — run the agent without a GUI terminal or
   AppleScript; capture stdout/stderr to per-request logs; report launch
   failure reliably; prefer `tmux` when an inspectable TTY is needed.
3. **Target registration & heartbeat** — register/refresh
   `devices`/`execution_targets` on start, update `last_seen_at`, expose
   connector readiness, keep a heartbeat so the UI can show
   online/idle/busy/stale/disabled.
4. **Target-scoped project resources** — each target's checkout path registered
   as a `project_resources` row scoped to that target; queueing warns/fails
   early when a selected target has no active resource for the project.
5. **Reliable wakeup** — polling first; evolve to outbound long-poll or runner
   SSE so a queued request wakes the target quickly via the same atomic claim
   endpoint. No inbound port to the target, ever.
6. **Central execution-request state machine** — consolidate
   queue/claim/launch/fail logic before expanding remote runners; remote targets
   magnify duplicated state handling and stale-launch gaps.

### Headless by design — no virtual desktops

The cloud execution model is **fully headless**, which keeps the Railway managed
runner within Railway's terms (VNC and virtual desktops are not permitted there):

- Agents are **CLI processes** (Claude Code, Codex CLI, etc.) launched by
  `ovld runner` in the headless launch profile — stdout/stderr captured to
  per-request logs, optional `tmux` for an inspectable TTY. No X server, no
  display server, no VNC, no graphical desktop.
- Inference runs on the user's own connected agent service, not on the runner,
  so the runner is just Node + Git + `ovld` + agent CLIs in a container.
- The UX items that sound graphical are not desktops: **"browser preview"** means
  headless Chromium (screenshots / DOM) or proxying the dev server's HTTP port,
  and **"Open shell"** means a PTY/terminal streamed over an audited backend
  session — neither needs a GUI.

If a use case ever genuinely requires a graphical desktop (a windowed IDE, a
human-watched interactive browser, VNC), it does **not** belong on Railway —
route it to a Daytona sandbox or a dedicated VM provider that permits virtual
desktops. The baseline Overlord Cloud offering does not need this.

### Future execution targets

- **Managed cloud persistent runner (Railway volume-backed service):** one
  service + volume per workspace/user, with `ovld runner start`, registered as
  `cloud_persistent`, outbound-only. Presented as "Create cloud computer" with a
  target details page (status, storage, linked repos, installed agents,
  shell/setup, reset/rebuild). This is the "home server in the cloud"
  experience; a Railway volume is single-instance, so treat it as a managed
  workstation, not elastic infra.
- **Daytona sandboxes (`cloud_sandbox`):** provider-adapter based, just-in-time
  sandboxes from snapshots for isolated/parallel/resettable work. Sync results
  back through Git branches and protocol delivery; stop/delete/snapshot per
  policy. Position as "disposable/resettable sandbox," not the default
  persistent workstation. Note Daytona volumes are FUSE-based and unsuitable for
  embedded database state needing block storage.

## Contract Changes Needed Before Implementation

Mostly additive if target type stays an open vocabulary and provider metadata is
namespaced. Update `CONTRACT.md` before code in these areas:

1. **Database Layer** — widen `execution_targets.type` toward `local`,
   `cloud_persistent`, `cloud_sandbox`, `ssh`; add nullable/namespaced provider
   metadata (provider, region, provisioned service id, lifecycle state, storage
   stats, capability flags); add target heartbeat fields or a target-status
   table if `devices.last_seen_at` is too device-specific; add a resource
   location model distinguishing local vs provider vs sandbox paths.
2. **REST API Layer** — target provisioning, heartbeat/status for non-local
   runners, provider-neutral capability DTOs; keep runner queue endpoints as the
   claim/launch boundary.
3. **CLI Layer** — runner registration for non-local targets; a
   no-persist-config mode for containers (injected backend URL + service token);
   target doctor commands for missing agent CLIs, Git creds, package managers,
   local services.
4. **Runner Layer** — target-aware beyond device fingerprint; capability
   matching on claim; cloud-safe path resolution and branch/worktree defaults;
   outbound-only polling baseline with optional server push later.
5. **Auth Layer** — scoped service tokens for cloud targets; revocation/rotation
   for provisioned runners; tokens that can claim only their target/workspace's
   requests.
6. **Web/Desktop** — target creation and detail surfaces; launch picker showing
   local/home-server/managed/sandbox targets with readiness/health; cloud-aware
   offline/realtime states; a documented Desktop **remote-client mode** (the
   current contract is loopback-local and supervises a local backend — Cloud
   mode points `backend_url` at the hosted backend, requires real auth, allows
   the remote origin in CSP/connect-src, and does not fork a local server). See
   "Desktop App: Switching Between Backends" for the full set of desktop and
   webapp changes this entails.

The highest-risk stable surface is queue claiming: it must remain centralized in
service-layer transactions and must not let provider adapters claim work
directly from database internals.

Implementation caveat resolved: the live backend data layer has been ported to
the async `DatabaseClient`, and the backend now boots against Postgres. Continue
to verify `entity_changes`, queue-claim atomicity, and protocol idempotency in
the deployed Railway runtime before announcing the hosted endpoint.

## Phased Plan

1. **Hosted control plane.** Deploy the Railway backend against Railway Postgres
   in EU West. Verify Postgres adapter conformance (`entity_changes`, claim
   atomicity, idempotency), protocol writeback, runner queue claim, and
   realtime. Keep local/home-server runners as the execution targets. Vercel web
   connects to the hosted backend.
1b. **Desktop multi-backend mode.** Implement backend profiles, origin/API
   decoupling, per-profile session partitions, bearer-token auth, and the
   reload-and-login switch flow so the desktop app can point at Local or
   Overlord Cloud (see "Desktop App: Switching Between Backends"). This is what
   lets desktop users reach the hosted control plane at all.
2. **Home server & BYO remote runner.** Harden target registration, heartbeat,
   and project-resource linking. Let users install `ovld` on another machine and
   link it with a short code/token. Target picker can choose that runner. No
   provider-specific provisioning yet.
3. **Railway managed persistent target.** Provision a Railway service + volume
   from Overlord, register as `cloud_persistent`, run `ovld runner start`, add
   target shell/setup UX and readiness checks.
4. **Daytona sandbox target.** Provider adapter for just-in-time sandboxes,
   snapshot-warmed, one-shot jobs synced back via Git + protocol delivery.

## Operational Tradeoffs

Benefits:

- Remote targets need only outbound HTTPS to the backend.
- The backend stays the single policy and state authority.
- Runners can be added, removed, or rotated without moving the database.
- Managed Postgres gives safe multi-writer queue claiming, HA, and backups.
- Desktop and web observe remote runner changes through the existing realtime
  feed.
- Local-only users are unaffected — Overlord Local keeps working with no account
  or network dependency.

Costs:

- Requires hosted backend uptime and a hosted DB.
- Requires token provisioning and rotation for headless devices.
- Requires a real runner service story (logs, diagnostics, supervision).
- Requires target-specific setup for checkouts and agent binaries.
- Requires a documented Desktop remote-client mode (auth, CSP, backend URL).

## UX Notes For A Seamless Experience

- One target picker for local, home server, managed cloud, and sandbox targets.
- Copy/paste-oriented setup: "Install runner on this machine" → `ovld auth
  login` + `ovld runner start`; "Create cloud target" provisions and returns
  once it heartbeats.
- Target readiness checklist: backend connected, Git provider/repo ready, agent
  CLI installed, agent provider auth present, project resource linked, caches
  warmed.
- Target capabilities surfaced in UI: persists repos, supports Docker/local
  Supabase, browser preview, concurrent jobs, snapshots, idle shutdown.
- Let users pin a project default target and override per objective.
- Route "Open shell"/"Open repo" through audited backend sessions, not raw SSH,
  at first.
- Keep secrets target-scoped; agent provider tokens live on the target or a
  server-side secret store, never returned to desktop/web clients.
- Show data gravity clearly: "This repo path exists on cloud-target-1, not on
  this laptop."

## Source Notes

- Railway: regions (US West/California, US East/Virginia, EU West/Amsterdam, SE
  Asia/Singapore — bare-metal); Postgres templates are unmanaged ("you have
  total control over their configuration and maintenance"); volumes are
  single-instance per service. Phase 1 uses EU West for both backend and
  Railway Postgres.
- Neon: AWS regions (`us-east-1`, `us-east-2`, `us-west-2`, `eu-central-1`,
  `eu-west-2`, `ap-southeast-1`, `ap-southeast-2`, `sa-east-1`); managed
  serverless Postgres with autoscaling, scale-to-zero, branching, instant/PITR
  restore, PgBouncer pooling; Azure regions deprecated; no GCP.
- Vercel: serverless functions are short-lived (WebSockets unsupported, SSE
  duration-capped); pin any DB-touching server code to `fra1` on the Node
  runtime for the EU deployment; first-class Neon integration remains relevant
  for the later Neon phase.
- Electron: do not load remote content into a renderer with a preload/IPC
  bridge; bundle local assets for privileged renderers.
