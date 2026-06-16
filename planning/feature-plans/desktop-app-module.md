# Desktop App Module — Integration Plan

**Status:** Proposal (planning only — no code in this ticket)
**Ticket:** 1:1493 — Plan Desktop App Module Integration
**Contract baseline:** `0.5-draft`
**Owning module (proposed):** `desktop/` → `@overlord/desktop` workspace package

---

## 1. Executive summary

Add an **optional** Electron module that is a thin desktop wrapper around the
existing OpenOverlord webapp. The desktop app does **not** reimplement product
logic — it loads the local web control center (`webapp/`) in a hardened
`BrowserWindow`, supervises the local processes the webapp depends on (the
REST/realtime server and, for launching agents, a runner), and gives the user a
native app shell (dock icon, window chrome, deep-linking, auto-update later).

Two deliberate departures from the closed-source `apps/desktop`:

1. **Authentication uses the sanctioned Auth Layer (Better Auth), not Supabase
   OAuth.** Because the desktop loads a **same-origin loopback** webapp, Better
   Auth's session cookies work natively inside the `BrowserWindow`. The closed
   app's entire bearer-token **header-injection** machinery
   (`services/header-injector.ts`, `oauth-tokens.ts`, `refresh-controller.ts`,
   `session-store.ts`, `electron-credentials.ts`) is **not needed** and is
   dropped. For spawned CLI/runner processes we use a **`USER_TOKEN`** (the
   credential the auth module already specifies) instead of an OAuth access
   token.

2. **Terminal/plugin/agent-install settings stay in the CLI** (per the ticket).
   The desktop module owns no terminal-config UI and no AppleScript terminal
   matrix. Instead it makes the **existing CLI/runner launch path** actually
   open a visible terminal window — which is the one real capability gap today
   (see §6).

The rest of this document records what the closed app does, why OpenOverlord is
different, the proposed design, the **contract impact** (a new component →
contract version bump, per `CONTRACT.md` maintenance rules), and a phased
implementation plan with concrete follow-up objectives.

---

## 2. How the closed Overlord `apps/desktop` works

Source: `github.com/cooperativ-labs/Overlord/tree/main/apps/desktop` (read for
this ticket). Layout:

```
apps/desktop/
  package.json            # esbuild bundles electron/main.ts + preload.ts → dist-electron
  electron-builder.yml    # dmg/zip (mac) + AppImage/deb (linux); bundles CLI + plugins; notarize
  tsconfig.json
  electron/
    main.ts               # app lifecycle, BrowserWindow, CSP, single-instance, IPC registration
    preload.ts            # contextBridge `electronAPI` (terminal, fs/git, auth, updates, …)
    ipc/                  # app.ts auth.ts filesystem.ts supabase.ts tailscale.ts terminal.ts
    services/             # agent-launcher.ts session-store.ts oauth-tokens.ts header-injector.ts
                          # refresh-controller.ts electron-credentials.ts cli-installer.ts
                          # agent-bundle/ overlord-plugin.ts agent-permissions.ts app-updater.ts
                          # quick-task-window.ts feed-window.ts settings-store.ts supabase-manager.ts …
    resources/
```

Key behaviors that matter for our port:

- **Window / URL loading (`main.ts`).** In dev it loads `http://localhost:3000/u`
  (the hosted **Next.js** platform); in prod it loads a configured **https**
  platform URL (`NEXT_PUBLIC_SITE_URL`). `webPreferences` use
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a
  `preload.js`. A single-instance lock is enforced; external-origin navigations
  and `window.open` are forced into the system browser. A strict **CSP** is set
  via `session.webRequest.onHeadersReceived`.

- **Auth = Supabase OAuth against a hosted multi-tenant platform.** On startup
  it builds a `refreshController` + `sessionStore`, stores OAuth tokens in an OS
  cred store (`electron-credentials.ts`), refreshes them via Supabase
  (`oauth-tokens.ts`), and **injects `Authorization: Bearer <access_token>`**
  into every request to the platform/Supabase origins via
  `session.webRequest.onBeforeSendHeaders` (`header-injector.ts`). It also
  strips Supabase auth `Set-Cookie`s and adds an `x-electron-client` marker.
  This whole apparatus exists because the renderer talks to a **remote**
  multi-tenant origin.

- **Terminal launcher (`ipc/terminal.ts` + `services/agent-launcher.ts`).**
  The renderer calls `electronAPI.launchAgent(payload)` →
  `ipcMain.handle('terminal:launch-agent')`. `prepareAgentLaunch()` resolves an
  OAuth bearer token, validates the working directory, and builds an
  **`ovld launch <agent> --ticket-id … --working-directory …`** command plus an
  env block (`OVERLORD_URL`, `OVERLORD_CONNECTOR_URL`, `OVERLORD_ACCESS_TOKEN`,
  `OVERLORD_LOCAL_SECRET`, `OVERLORD_ORGANIZATION_ID`). `terminal.ts` writes a
  guarded bash launch script to a temp file and **opens a visible terminal
  window** running it — with a large AppleScript/`open -a` matrix for Terminal,
  iTerm, Warp, Ghostty, Alacritty, Kitty, Hyper, tmux, cmux, and custom apps,
  honoring tab/window/hotkey launch modes read from its own `settings-store`.
  There is also `terminal:choose-directory` and a Homebrew `jj` installer.

- **Lots of other IPC/services** we are explicitly told to **defer**:
  CLI install (`cli-installer.ts`), agent bundle/plugin install
  (`agent-bundle/`, `overlord-plugin.ts`, `agent-permissions.ts`), Tailscale,
  Supabase manager, quick-task hotkey window, feed window, auto-updater.

- **Packaging (`electron-builder.yml`).** Bundles `packages/open-overlord/**`
  and the `plugins/**` into the app (with `asarUnpack`), targets dmg/zip +
  AppImage/deb, sets electron fuses, and runs a notarize step after signing.

---

## 3. Why OpenOverlord is different (and what that buys us)

| Concern | Closed Overlord | OpenOverlord (this repo) | Consequence for the desktop app |
| --- | --- | --- | --- |
| Web UI | Hosted **Next.js** at a remote https origin | **Local** Vite React SPA + Express server (`@overlord/webapp`) on a loopback origin | Load `http://127.0.0.1:<web_port>/` (default `web_port = 4310`, `overlord.toml`). Same-origin, loopback. |
| Data | Hosted multi-tenant Postgres | Local **SQLite** (default `database/.local/Overlord.sqlite`), single trusted local user | The CLI/runner talk **directly to the DB via the service layer**, not over HTTP — no network token needed locally. |
| Auth | Supabase OAuth + bearer header injection | **Better Auth** (`@overlord/auth`: `emailAndPassword` + `bearer()` plugin, sessions in the same DB) + **`USER_TOKEN`** module | Session **cookies on the loopback origin work natively** in the `BrowserWindow`. Drop header-injection entirely. |
| Launch | Electron opens a terminal window itself | `webapp` **queues an `execution_request`**; an `ovld runner` claims it and calls `launchAgent` | The launch path exists but `launchAgent` runs **inline** today (see §6) — the desktop must make it open a window. |
| Terminal config | Stored in Electron `settings-store` | CLI-owned: `overlord.toml` (`terminal_launcher`, currently commented-out/unparsed) | Terminal settings stay in the CLI; the desktop only triggers the launch. |

**Net simplification:** because the renderer and the API are the same loopback
origin and auth is cookie-based, the desktop module is genuinely a *light
wrapper* — no token plumbing, no header rewriting, no Supabase. The only real
new capability needed across the stack is "open the launched agent in a visible
terminal window," and that belongs in the CLI/runner, not in Electron.

---

## 4. Proposed module: placement, structure, optionality

OpenOverlord uses a **flat module layout** (top-level `auth/`, `automations/`,
`cli/`, `database/`, `webapp/`, `connectors/`, `mcp/`), not the closed repo's
`apps/*`. Add a sibling:

```
desktop/                          # @overlord/desktop (NEW workspace package)
  package.json                    # esbuild build of main+preload; electron + electron-builder
  electron-builder.yml
  tsconfig.json
  README.md                       # module home (maps to the new contract component)
  conformance-manifest.yaml       # componentType: desktop-shell (NEW enum value — see §7)
  src/
    main.ts                       # app lifecycle, window, CSP, single-instance, process supervision
    preload.ts                    # minimal contextBridge: launch trigger, choose-directory, meta
    ipc/
      launch.ts                   # terminal:launch — delegates to CLI/runner (no AppleScript matrix)
      app.ts                      # version, open-external, reveal-in-finder, meta passthrough
    services/
      server-supervisor.ts        # spawn/await/stop the webapp server (`ovld serve`)
      runner-supervisor.ts        # spawn/stop a local runner with terminal-open mode
      cli-resolver.ts             # locate the bundled/global `ovld` binary
    resources/                    # icons
  docs/
    desktop-app.md                # behavior spec (moves here from this planning doc once built)
    testing.md
```

**Optionality (hard requirement from the objective — "optional Desktop App
module"):**

- Add `desktop` to root `workspaces` **but keep it out of the default
  `build`/`dev`/`test`/`typecheck` aggregate scripts** in the root
  `package.json`. Electron + electron-builder are heavy, platform-specific dev
  deps; default `yarn install`/`yarn build` must not require them. Gate the
  module behind explicit scripts: `yarn workspace @overlord/desktop dev` /
  `… build` / `… package`, and optionally a root convenience alias
  `yarn desktop` that fails with a helpful message if deps are absent.
- The desktop module **depends on** `webapp` (URL + REST surface) and the
  packaged `open-overlord`, but `webapp` and `cli` must have **no build/runtime
  dependency on `desktop`** — the dependency arrow points one way only.
- Document it as the eighth row in the README module table and mark it
  "optional / not built by default."

---

## 5. The desktop shell: window, security, lifecycle

### 5.1 Window & security (port the good parts of `main.ts`)

- `BrowserWindow` with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `preload` via `contextBridge` — **keep these
  exactly**; they are the security baseline.
- **CSP** via `onHeadersReceived` scoped to the loopback origin. Simpler than
  the closed app because there's no Supabase origin: allow `'self'` + the
  loopback `http`/`ws` origin for `connect-src` (SSE/realtime). No remote
  `https:`/`wss:` wildcard needed for the default local case.
- Single-instance lock; force external-origin navigations and `window.open`
  into the system browser (reuse the closed app's `will-navigate` /
  `setWindowOpenHandler` logic verbatim — it's origin-comparison only).
- Native context menu (spellcheck/copy/paste) — nice-to-have, port as-is.

### 5.2 Process lifecycle — two modes

The webapp needs its server running. Offer:

- **Mode A — Connect-only (Phase 1, lowest risk).** Assume the user started the
  server (`ovld serve` / `yarn start`). The shell loads
  `http://127.0.0.1:<web_port>/`, polls `GET /api/health` until ready, and
  shows a friendly "waiting for Overlord server…" splash with a retry. No child
  processes.
- **Mode B — Supervise (Phase 3, the real desktop experience).** On launch the
  shell spawns the webapp server itself (`server-supervisor.ts` →
  `ovld serve --host 127.0.0.1 --port <web_port>`), waits for health, loads the
  URL, and tears the server down on `before-quit`. Optionally also supervise a
  local runner (`runner-supervisor.ts`) so the Launch button works with zero
  manual setup.

> **Dependency:** Mode B and the README both assume an **`ovld serve`** command.
> It is referenced in `README.md` ("Users will use `ovld serve` …") and the port
> default exists (`config.ts` `webPort: 4310`), but **`serve` is not yet
> implemented** in `cli/src/commands.ts` (the webapp is started today via
> `yarn workspace @overlord/webapp start`). Implementing `ovld serve` (a thin
> CLI command that boots `webapp/server/index.ts` with the resolved
> host/port/db) is a prerequisite sub-objective and is independently useful.

### 5.3 What the renderer is

It is the **unmodified** `webapp` SPA. The desktop app should require **no
forks** of the SPA. If we want desktop-only affordances (e.g. "reveal repo in
Finder"), expose them through a small `window.overlord` bridge from `preload.ts`
that the SPA **feature-detects** (`if (window.overlord?.launchInTerminal)`),
exactly like the closed app's `electronAPI` pattern but far smaller.

---

## 6. The terminal launcher (the one real gap)

### 6.1 Current reality

- The webapp **Launch** button calls `POST /api/objectives/:id/launch`
  (`webapp/server/launch.ts`) which **queues an `execution_request`** and emits
  an `execution_requested` event. It does **not** open a terminal. Capability
  `executionTargets: false`, `launchAgents: true` (`/api/meta`).
- An `ovld runner start` claims queued requests
  (`cli/src/commands.ts` `runner` case) and calls `launchAgent()`.
- **`launchAgent()` (`cli/src/launch.ts`) runs the agent INLINE** via
  `spawnSync(plan.command, plan.args, { stdio: 'inherit' })` — i.e. in the
  runner's **own** terminal/process. There is **no** code anywhere in `cli/` or
  `src/` that opens a *new* terminal window (no `osascript`, `open -a`,
  `gnome-terminal`, `wt.exe`, etc.).
- `overlord.toml` shows a **commented-out** `terminal_launcher` example, and
  `cli/src/config.ts` does **not parse** a `terminal_launcher` key — it's not
  wired to anything.

So "make sure the terminal launcher works" is not just a wrapper concern: the
underlying capability to **open a visible terminal window running the agent does
not exist yet**.

### 6.2 Recommended approach — put terminal-opening in the CLI/runner

This respects the ticket ("leave terminal settings in the CLI") and the contract
(CLI owns "Default terminal configuration"; the Runner owns launch/execution),
and it benefits non-desktop users too (anyone running `ovld runner`).

1. **Wire `terminal_launcher` into config** (`cli/src/config.ts` +
   `overlord.toml` writer): parse a `terminal_launcher` string (e.g.
   `open -a Ghostty --args`, `wezterm start`, `gnome-terminal --`) and an
   optional per-OS map.
2. **Add an "open in terminal" launch mode** to the launch path. Two shapes,
   pick one:
   - `ovld launch <agent> … --in-terminal` (and the runner gains
     `--open-terminal`), **or**
   - a dedicated `ovld open-terminal --script <path>` primitive that the
     launch/runner code calls.
   Implementation mirrors the *non-AppleScript* parts of the closed app's
   `agent-launcher.ts`/`terminal.ts`: write a guarded bash launch script
   (the closed app's `buildLaunchScriptContent` is a good reference — it adds a
   `cd` guard and an "agent exited immediately" diagnostic), then invoke the
   configured `terminal_launcher` with that script. Default to inline (current
   behavior) when no launcher is configured, so nothing breaks.
3. **The desktop module just triggers this.** When the user clicks Launch in the
   wrapped SPA, the existing `execution_request` is queued and the
   **desktop-supervised runner** (`--open-terminal`) opens the window. No
   Electron-side terminal code beyond an optional `terminal:launch` IPC that
   shells out to `ovld launch … --in-terminal` for a direct (non-queued) path.

### 6.3 Alternative — port the Electron terminal matrix (fallback only)

We *could* port `ipc/terminal.ts` + `services/agent-launcher.ts` into
`desktop/src/ipc/launch.ts` and have Electron open the terminal (AppleScript
matrix etc.). **Not recommended as the primary path:** it duplicates terminal
configuration **outside** the CLI (contradicting the ticket), is macOS-centric,
and leaves non-desktop runner users without window-opening. Keep it in our back
pocket only if we must ship the desktop shell before touching the CLI.

### 6.4 Working-directory picker

Port `terminal:choose-directory` (Electron `dialog.showOpenDialog`) as a small
desktop convenience for linking a project to a local path — it has no CLI/config
coupling and is genuinely shell-only.

---

## 7. Authentication — the "more standard mechanism"

**Goal:** replace closed Overlord's Supabase-OAuth + header-injection with the
auth that already ships in this repo.

### 7.1 In-app (renderer) auth — Better Auth session cookies

- `@overlord/auth` already exposes `createAuth()` with `emailAndPassword`
  enabled and the `bearer()` plugin, backed by the same adapter as the rest of
  the app (`auth/src/auth/config.ts`). Today the **webapp server does not mount
  it** — `webapp/server/index.ts` runs as the implicit single trusted local
  user, and `webapp/docs/web-app.md` states the first local version "should not
  require auth."
- Sub-objective (webapp + auth): **mount the Better Auth handler** at
  `/api/auth/*` in `webapp/server/index.ts`, add a **login screen** to the SPA,
  and resolve the acting user from the Better Auth session (replacing the hard
  `ACTOR_WORKSPACE_USER_ID` constant where appropriate).
- **Why this is "more standard":** because the desktop loads a **same-origin
  loopback** page, Better Auth's `Set-Cookie` session works **natively** in the
  `BrowserWindow` — no `onBeforeSendHeaders` rewriting, no OS cred store, no
  refresh controller, no Supabase. The desktop shell does *nothing special* for
  in-app auth.
- **Local-first ergonomics:** keep auth **optional** for pure-loopback use
  (default to an auto-provisioned local operator so existing local workflows
  don't regress), and **required** when the server binds a non-loopback host —
  which is exactly the shared/private-network case `auth/src/auth/config.ts`
  already anticipates (Postgres + Better Auth). Make this a config switch
  (e.g. `auth_required` in `overlord.toml`, default `false` for loopback).

### 7.2 Spawned CLI/runner auth — `USER_TOKEN`

- For **local** loopback execution, the supervised runner/`ovld launch` talk
  **directly to the SQLite service layer** and need **no network credential** at
  all (the closed app only needed `OVERLORD_ACCESS_TOKEN` because the CLI hit a
  remote HTTP platform).
- For **remote/shared** deployments (server bound to a private-network host, or
  the desktop pointed at a remote OpenOverlord URL), the spawned CLI needs a
  credential. Use the **`USER_TOKEN`** the auth module already specifies
  (`auth/docs/07-user-token-authentication.md`): after login the desktop mints
  or selects a token via the existing REST surface
  (`POST /api/user-tokens` → `webapp/server/repository.ts`) and passes it to the
  child process as **`Overlord_USER_TOKEN`** (the documented CLI env var; alias
  `OVLD_USER_TOKEN`). This is the clean, "standard" analog of the closed app's
  `OVERLORD_ACCESS_TOKEN` and reuses the bearer plugin Better Auth already
  enables.

### 7.3 What we delete vs the closed app

Dropped entirely (loopback + cookies make them unnecessary):
`services/header-injector.ts`, `services/oauth-tokens.ts`,
`services/refresh-controller.ts`, `services/session-store.ts`,
`services/electron-credentials.ts`, `ipc/supabase.ts`,
`services/supabase-manager.ts`, the `x-electron-client`/`OVERLORD_LOCAL_SECRET`
markers, and the Supabase CSP `connect-src` entries.

---

## 8. Explicitly deferred (stay in the CLI for now)

Per the objective, the desktop module does **not** include:

- Terminal **configuration** UI (lives in `overlord.toml` / CLI).
- Connector / agent-plugin **installation** (`agent-bundle/`,
  `overlord-plugin.ts`, `cli-installer.ts`, `agent-permissions.ts`).
- Tailscale, quick-task hotkey window, feed window, auto-updater (Phase ≥4
  niceties).

These remain CLI surfaces. The desktop app may *link out* to the relevant
`ovld` commands or docs, but does not own their settings.

---

## 9. Contract impact (required reading per `CLAUDE.md` + `CONTRACT.md`)

Adding a new module is a **contract-modifying change**. Per
`CONTRACT.md` → "Contract Maintenance Rules", a *new component* and a *new
conformance `componentType`* **require a contract version bump** and updates to
the machine-readable files. The contract update **must land before**
implementation code.

Proposed changes (bump `0.5-draft` → `0.6-draft`):

1. **New component in the registry.** Add a `desktop` (a.k.a. "Desktop Shell")
   component to `CONTRACT.md` "Component Registry" and `contract/components.yaml`.
   - **Owns:** the Electron shell lifecycle; loading the local webapp; process
     supervision of the webapp server (+ optional runner); the minimal
     `preload` bridge surface; desktop packaging.
   - **Does NOT own:** REST/SSE shapes (→ `rest`), CLI/launch/terminal config
     (→ `cli`/`runner`), auth mechanism (→ `auth`), DB schema (→ `database`).
   - **Depends on:** `rest` (loads the SPA + calls `/api/*`), `cli`/`runner`
     (spawns `ovld serve`/`ovld runner`/`ovld launch`), `auth` (cookies/tokens).
2. **New conformance `componentType`.** `contract/conformance-manifest.schema.yaml`
   currently enumerates `connector | extension | database-adapter |
   auth-provider | rest-module`. Add **`desktop-shell`** (or `client-shell`) and
   ship `desktop/conformance-manifest.yaml` declaring it.
3. **Interaction surfaces.** The desktop shell reuses existing surfaces:
   - *Renderer → REST* (loopback HTTP + SSE) — already the `restApiToDatabase`-
     backed REST surface; the shell is just another HTTP client.
   - *Shell → CLI* (subprocess) — analogous to the existing
     *Agent → Protocol* subprocess pattern; document a "Shell → CLI (process
     supervision/launch)" surface note rather than a new transport.
   No new DB tables or vocabularies are required.
4. **CLI/runner additions** (from §6): document the `--in-terminal` /
   `--open-terminal` launch mode in `cli/docs/04-runner-and-launch-execution.md`
   and add `terminal_launcher` to the CLI-owned config-key list in `CONTRACT.md`
   + `contract/components.yaml` (CLI already *owns* terminal configuration, so
   this is an additive config key, not a new ownership boundary).
5. **`ovld serve`** (from §5.2): document the new command in
   `cli/docs/02-cli-first-product-surface.md` and `contract/protocol-commands.yaml`
   is unaffected (this is a management command, not a protocol command), but the
   CLI command surface doc must list it.

Run `ovld contract check desktop/conformance-manifest.yaml` (or the validation
script) as part of the conformance gate.

---

## 10. Build & packaging

Mirror the closed app's proven setup, scaled down:

- **Bundle main + preload with esbuild** (`format=cjs`, `platform=node`,
  `target=node20`, `external: electron` + native modules), output to
  `desktop/dist-electron/`.
- **`electron-builder.yml`:** targets `dmg`+`zip` (mac), `AppImage`+`deb`
  (linux); `appId: io.cooperativ.openoverlord` (or similar); set the same
  hardening fuses; `npmRebuild: false`.
- **Bundle the CLI + connector plugins** so the spawned `ovld` and any installed
  plugins exist offline: include the packed `open-overlord` tarball/dir and
  `connectors/adapters/**`, `asarUnpack` them (they're executed as subprocesses
  / read from disk). `cli-resolver.ts` resolves `ovld` from the unpacked
  location first, then global `PATH`.
- **Signing/notarization** (mac) is a release-time concern — Phase 5, not needed
  for internal dev builds.
- **Native modules:** `better-sqlite3` is used by `webapp`/`auth`/`database`. If
  the desktop **supervises** the server in-process it would need a matching
  native build; supervising it as a **child `node`/`ovld` process** sidesteps
  Electron's ABI entirely. Prefer the child-process approach (also matches the
  repo memory note that `better-sqlite3` is rebuilt per-platform).

---

## 11. Phased implementation plan (proposed follow-up objectives)

Each phase is a candidate objective/ticket. Phases 0–2 deliver a usable wrapper;
3–5 make it a polished product.

- **Phase 0 — Contract + scaffold.**
  Bump contract to `0.6-draft`; add the `desktop` component + `desktop-shell`
  conformance type to `CONTRACT.md`, `contract/components.yaml`,
  `contract/conformance-manifest.schema.yaml`. Create the `desktop/` workspace
  (package.json, tsconfig, esbuild config, README, `conformance-manifest.yaml`),
  added to root `workspaces` but **excluded from default build/test**.

- **Phase 1 — Connect-only shell.**
  `main.ts` window with the security baseline + CSP + single-instance + external-
  link handling; load `http://127.0.0.1:<web_port>/`; health-poll splash. Minimal
  `preload.ts`. Manual `yarn start` server. **Acceptance:** the desktop window
  renders the existing SPA and is fully usable for everything that doesn't open a
  terminal.

- **Phase 2 — Terminal launcher works (the headline).**
  Implement the CLI/runner **open-in-terminal** capability (§6.2): parse
  `terminal_launcher`, add `ovld launch --in-terminal` + `ovld runner
  --open-terminal`, port the script-builder (cd-guard + exit diagnostics).
  Desktop supervises a runner (`runner-supervisor.ts`) so clicking **Launch** in
  the SPA opens a real terminal with the agent. Add `terminal:choose-directory`.
  **Acceptance:** from the desktop app, launching an objective opens the
  configured terminal running `ovld launch <agent> --ticket-id …` in the
  project directory; `--dry-run` proves the command/script shape in tests.

- **Phase 3 — `ovld serve` + server supervision.**
  Implement `ovld serve` (boot `webapp/server/index.ts` with resolved
  host/port/db). Desktop Mode B: spawn/await/stop the server on app
  launch/quit. **Acceptance:** launching the desktop app with no prior setup
  brings up the server and UI; quitting stops it cleanly.

- **Phase 4 — Better Auth login.**
  Mount Better Auth at `/api/auth/*`; SPA login screen; resolve actor from
  session; `auth_required` config (default off for loopback, on for non-
  loopback). Desktop mints/uses `Overlord_USER_TOKEN` for spawned CLI when a
  credential is required. **Acceptance:** with `auth_required = true`, the
  desktop shows the Better Auth login and authenticated REST/launch work via
  cookies (in-app) and `USER_TOKEN` (spawned CLI), with **no** header injection.

- **Phase 5 — Packaging & release.**
  `electron-builder` dmg/AppImage/deb bundling the CLI + plugins; optional
  auto-updater + signing/notarization. **Acceptance:** a packaged build runs on
  a clean machine and can launch an agent terminal end-to-end.

---

## 12. Open decisions for the user

1. **Server lifecycle default:** ship Phase-1 *connect-only* first, or go
   straight to *supervised* (`ovld serve` spawned by the app)?
   *Recommendation:* connect-only first (fastest path to a working terminal
   launcher), supervise in Phase 3.
2. **Terminal launching location:** confirm the **CLI/runner** owns
   open-in-terminal (recommended, §6.2) rather than porting the Electron
   AppleScript matrix (§6.3). This is the central design choice.
3. **Conformance type name:** `desktop-shell` vs `client-shell` for the new
   `componentType` enum value.
4. **Auth default:** keep loopback **unauthenticated** by default (with an
   auto-provisioned local operator) and only require Better Auth login when
   bound to a non-loopback host? *Recommendation:* yes.
5. **macOS-only vs cross-platform first:** the closed terminal matrix is
   macOS-heavy. The CLI `terminal_launcher` approach is naturally cross-platform
   — confirm we target mac + linux from the start.

---

## 13. Risks & notes

- **Terminal launcher is a real feature, not just wiring.** The headline ask
  depends on a capability that doesn't exist in the CLI today (inline-only
  launch). Phase 2 is the riskiest/most valuable phase; budget for it.
- **`ovld serve` is referenced but unimplemented** — don't assume it exists.
- **Don't fork the SPA.** Keep desktop affordances behind a feature-detected
  `window.overlord` bridge so `webapp` stays the single source of UI truth.
- **Native module ABI:** supervise the server as a child process to avoid
  Electron/`better-sqlite3` ABI mismatches (consistent with existing repo notes
  about per-platform `better-sqlite3` rebuilds).
- **Contract-first:** the component + conformance-type changes (Phase 0) must
  land before any desktop code, per `CONTRACT.md`.
- **Optionality must be enforced in scripts**, not just intent: a developer who
  never touches the desktop must never be forced to install Electron.
