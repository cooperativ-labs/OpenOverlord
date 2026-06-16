# Desktop App Packaging — SQLite Distribution & Signed macOS Build

**Status:** Proposal (planning only — no code in this ticket)
**Ticket:** coo:2 — *Package desktop app with SQLite and CLI*
**Contract baseline:** `0.5-draft` (this plan rides the `0.6-draft` bump proposed by [`desktop-app-module.md`](desktop-app-module.md))
**Companion plans:**
- [`desktop-app-module.md`](desktop-app-module.md) — the Electron *shell* (window, security, auth, terminal launcher). **Read it first.**
- [`railway-postgres-deployment-recommendation.md`](railway-postgres-deployment-recommendation.md) — the *other* distribution (hosted/dev Postgres).

---

## 1. TL;DR

1. **This plan is the packaging & signing pipeline, not a second shell.** The
   [desktop shell plan](desktop-app-module.md) already commits to an Electron
   wrapper around the existing `webapp` and explicitly *defers* "signing /
   notarization ... Phase 5, not needed for internal dev builds." coo:2 **is**
   that deferred Phase 5, plus the SQLite-specific work needed to turn the dev
   wrapper into a **downloadable, double-click, signed macOS app** that bundles
   the SQLite DB + the `ovld` CLI as one artifact.

2. **The deliverable is one script.** `scripts/build-desktop.ts` (exposed as
   `yarn desktop:package`) takes our **existing built modules** as input and
   emits a **signed, notarized `.dmg` + `.app`** into a folder the operator
   specifies (`--out <dir>`). Signing/notarization credentials come from
   environment variables so the script runs headlessly; with `--no-sign` it
   produces an ad-hoc build for local testing.

3. **One runtime, not two.** Run the webapp server inside Electron via
   `utilityProcess.fork()` (Electron's own Node context) rather than shipping a
   separate Node binary. We rebuild the single native module (`better-sqlite3`)
   **once** for Electron's ABI. This refines the shell plan's "supervise as a
   child node process" note: a `utilityProcess` gives the same process isolation
   *without* a second runtime to ship, sign, and notarize. (The bundled CLI is
   the one piece that still needs a plain-Node ABI build — see §7.)

4. **The hard part is not Electron, it is making SQLite portable.** Today the
   server **throws if the DB file is absent** (`webapp/server/db.ts:26`), the DB
   path is **repo-relative** (`database/.local/Overlord.sqlite`), and the server
   runs from **TypeScript via `tsx`** importing `.ts` across workspaces. A
   packaged app has no repo. So the SQLite work is: relocate data/config to an
   **app-data directory**, **create + migrate on first launch**, bundle the
   server to plain JS, and make the **embedded server and the bundled CLI agree
   on the same DB file**.

5. **Purely additive — DX and the Postgres path are untouched.** Everything
   lives in the optional `desktop/` workspace + one root script, excluded from
   the default `build`/`dev`/`test` aggregate. `yarn dev`, `yarn pack:cli`, and
   the Railway/Postgres deploy are unchanged. The desktop build is just the
   **SQLite-only, GUI-wrapped variant** of the existing local instance.

---

## 2. Where this fits: three distributions, one codebase

Overlord ships the **same modules** three ways. This plan adds the third row;
the first two already exist / are planned elsewhere.

| Distribution | Audience | DB | UI entry | Status / owner |
| --- | --- | --- | --- | --- |
| **Source repo** | Contributors, forkers | SQLite (default) or Postgres | `yarn dev` (Vite + `tsx` server) | Exists today |
| **Railway / Postgres** | Shared / hosted / multi-runner | Postgres (`DATABASE_URL`) | `ovld serve` behind a host | [railway plan](railway-postgres-deployment-recommendation.md) |
| **Downloadable desktop** | End users on one Mac, zero infra | **SQLite only** (forced) | Double-click `.app` → Electron window | **This plan (coo:2)** |

The desktop distribution is deliberately the **most constrained**: SQLite only,
loopback only, single local operator. It is the "I just want to run Overlord on
my laptop" front door. It must never become a fork of the product — it is a
packaging of it.

**SQLite selection is already free.** `database/src/adapter.ts` selects SQLite
whenever `DATABASE_URL` is unset. The desktop app simply never sets
`DATABASE_URL`, so the adapter contract (and the railway plan's "SQLite remains
a supported local option") holds with **no contract change to DB selection**.

---

## 3. What "packaged as one" must contain

Inventory of what the signed `.app` bundle ships (all derived from existing
modules — no new product code beyond glue):

| Component | Source | Form in the bundle |
| --- | --- | --- |
| Electron shell (main + preload) | `desktop/` (per [shell plan](desktop-app-module.md)) | esbuild → `dist-electron/` inside `app.asar` |
| Web control center (SPA) | `webapp/web` → `vite build` → `webapp/dist` | static files served by the embedded server |
| REST/realtime server | `webapp/server/*` + `src/service/*` + `cli/src/config` | **esbuild bundle** → run via `utilityProcess.fork()` |
| Database runtime + migrations | `@overlord/database` (`dist/` + `sqlite/migrations/`) | unpacked (migrations read from disk) |
| `better-sqlite3` native addon | `node_modules/better-sqlite3` | **Electron-ABI** build (server) **+ Node-ABI** build (CLI) |
| `ovld` / `overlord` CLI | `open-overlord-cli` packed tarball | `asarUnpack`'d under `Contents/Resources/cli` |
| Default config template | generated `overlord.toml` | written into app-data dir on first run |
| Icons / Info.plist / entitlements | `desktop/resources/` | bundle metadata |

Optional / explicitly **not** bundled: Postgres anything, Gemini key (stays an
opt-in env var; automations degrade to local fallbacks per the contract),
connector plugin auto-install (deferred by the shell plan).

---

## 4. Architecture decisions for a *distributable* app

The shell plan made decisions for a *dev wrapper*. Distribution + signing
changes two of them. Both are refinements, not reversals.

### 4.1 Run the server in a `utilityProcess`, not an external Node

The shell plan (§10) suggested supervising the server "as a child
`node`/`ovld` process ... [to] sidestep Electron's ABI entirely." That is right
for a *dev machine that has Node installed*. For a **download-and-launch**
artifact it is wrong: we would have to bundle and sign a **second runtime** (a
standalone Node binary), doubling the native-module and notarization surface.

**Decision:** boot the bundled server with Electron's
[`utilityProcess.fork()`](https://www.electronjs.org/docs/latest/api/utility-process).
A `utilityProcess` runs in a **Node.js context on Electron's ABI**, fully
isolated from the renderer (no `nodeIntegration` in the window), but uses the
runtime we are *already* shipping and signing. Net effect:

- One runtime to ship, sign, notarize (Electron).
- One native-module ABI to rebuild for the server (`better-sqlite3` against
  Electron — handled by `electron-builder` / `@electron/rebuild`).
- Server still crashes/restarts independently of the UI; main process
  supervises it (the shell plan's `server-supervisor.ts`, retargeted from
  `spawn('ovld serve')` to `utilityProcess.fork(serverBundle)`).

### 4.2 Bundle the server to plain JS (it currently runs on `tsx`)

`webapp/server/index.ts` imports TypeScript **across workspace boundaries**:

```ts
import { loadConfig } from '../../cli/src/config.ts';   // .ts, not built
import { DATABASE_PATH, WORKSPACE } from './db.ts';
import { createServiceContext } from '../../src/service/context.js';
```

`build:webapp` only runs `vite build` (the SPA). The server is never compiled —
`yarn start` runs `tsx server/index.ts`. A packaged app cannot depend on `tsx`
or on `.ts` source resolution.

**Decision:** add an **esbuild server-bundle step** (in `desktop/`, or a
`webapp` build script `build:server`) that bundles `webapp/server/index.ts` and
its `.ts`/`.js` dependency graph (`src/service`, `cli/src/config`, `webapp/shared`)
into a single CJS/ESM file, with `better-sqlite3` marked **external** (loaded
from the unpacked native build at runtime). Output: `webapp/dist-server/index.js`.
This is the file `utilityProcess.fork()` runs. The dev flow keeps using `tsx`
unchanged.

### 4.3 Architectures & the native module

`better-sqlite3` produces one `.node` per `{platform, arch, ABI}`. For macOS we
target **arm64 and x64** (Apple Silicon + Intel). Options:

- **Two single-arch builds** (`Overlord-arm64.dmg`, `Overlord-x64.dmg`) — simplest;
  each only carries its own native binary. Recommended for v1.
- **Universal build** (`--universal`) — one DMG, but requires lipo-merging two
  `better-sqlite3` binaries; `electron-builder` supports it with extra config.
  Defer unless a single download is a hard requirement.

The build script takes `--arch arm64|x64|universal` (default: host arch).

---

## 5. Making SQLite portable (the core of coo:2)

This is the work that turns "runs in the repo" into "runs anywhere." Each item
is a concrete, necessary change; none affect the dev or Postgres paths.

### 5.1 App-data directory (no repo, no cwd)

In the repo, paths resolve relative to cwd / the `overlord.toml` found by walking
up (`cli/src/config.ts` `findConfigPath`, `resolveDatabasePath`). A packaged app
runs from `/Applications` with an arbitrary cwd. Introduce a single
**packaged-mode data root**:

```
~/Library/Application Support/Overlord/      (Electron app.getPath('userData'))
  overlord.toml          # generated on first run (instance name, web_host/port, db path)
  Overlord.sqlite        # the database (+ -wal / -shm)
  storage/               # object storage buckets (attachments, user-images, …)
  logs/                  # server + app logs
```

The shell's main process resolves this dir and passes it to the server (and the
CLI) so **everything points at the same place**. Two existing hooks make this
clean — no new config machinery needed:

- `OVERLORD_SQLITE_PATH` (absolute) is already honored by
  `webapp/server/db.ts:17`, `database/src/connection.ts:116`, and
  `cli/src/config.ts:173`. The app exports it for both the server `utilityProcess`
  and any spawned CLI.
- `resolveDatabasePath` already accepts an **absolute** `database_path` in
  `overlord.toml`. The generated config writes the app-data absolute path.

Also relocate **object storage**: `database/src/local-paths.ts` hard-codes
`database/.local/storage/...`. Add an env/config override
(`OVERLORD_STORAGE_DIR`, consumed by `webapp/server/storage.ts`) defaulting to
the repo path, set to `<userData>/storage` in packaged mode.

### 5.2 First-run: create + migrate, do not throw

`webapp/server/db.ts:26` throws if the DB file is missing, telling the user to
run `yarn start:local`. There is no repo and no `yarn` in a packaged app.

**Decision:** before the server `utilityProcess` opens the DB, the boot path must
**create the directory and run migrations** if the file is absent — exactly what
`database/src/connection.ts` `openDatabase()` + `migrateDatabase()` and
`cli/src/runtime.ts` already do, and what `ovld init` does
(`cli/src/management.ts:25`). Concretely: have the packaged server entry call
`openDatabase({ databasePath })` + `migrateDatabase(db)` (which `mkdir -p`s and
applies `sqlite/migrations`) and **seed the first workspace** (the launcher
`database/src/launch-local.ts` + initial-setup flow already establish a seeded
workspace; `webapp/server/db.ts` expects `oldestWorkspaceRow()` to exist).

Cleanest implementation: introduce **`ovld serve`** (already referenced in
`README.md` and assumed by the shell plan, but **not implemented**) as the single
"boot a fully-initialized local instance" entry: resolve adapter → create +
migrate + seed if empty → start the Express app. The desktop bundle then forks
the same code path. This keeps one boot path for repo (`yarn start` → `ovld
serve`), Railway, and desktop.

### 5.3 The embedded server and the bundled CLI must agree

Agents call `ovld protocol …` from a terminal *outside* Electron, but those
calls must hit the **same database** the window shows. Both resolve the DB via
the mechanisms in §5.1. The "Install CLI" action (§7) and any app-spawned CLI
get `OVERLORD_SQLITE_PATH` (and `OVERLORD_STORAGE_DIR`) pointed at the app-data
dir, and the generated `overlord.toml` lives there too so a bare `ovld` run from
the user's project still finds it (config discovery falls back to the app-data
config when no repo-local `overlord.toml` exists — see §9 contract note).

### 5.4 WAL & concurrency

The DB is opened in WAL mode (`db.ts:38`, `connection.ts:72`) so the embedded
server and a CLI/agent process can read/write concurrently against the one file —
this is already the local-multi-writer story and needs no change, only that both
processes open the *same* path on a local (non-network) filesystem
(`~/Library/Application Support` qualifies).

---

## 6. The build & signing script (the headline deliverable)

> **Goal restated from the ticket:** "a script I can use to generate and sign the
> macOS binary and output it to a folder I specify ... inputs are just our
> existing modules."

### 6.1 Interface

```bash
# Signed, notarized release into ~/Desktop/overlord-dist
yarn desktop:package --out ~/Desktop/overlord-dist --arch arm64 --sign --notarize

# Local unsigned (ad-hoc) build for testing — no Apple account needed
yarn desktop:package --out ./build --no-sign
```

Flags: `--out <dir>` (required), `--arch arm64|x64|universal` (default host),
`--sign` / `--no-sign`, `--notarize` (implies `--sign`), `--dmg`/`--zip`
(default both). Implemented as `scripts/build-desktop.ts` (run with `tsx`) that
orchestrates `electron-builder`; thin enough to read top-to-bottom.

### 6.2 Pipeline (each step uses existing module outputs)

1. **Build modules** — `yarn build:db && build:auth && build:automations &&
   build:cli` (existing scripts) + **`build:webapp`** (SPA) + the new
   **`build:server`** esbuild bundle (§4.2).
2. **Stage the CLI** — `yarn pack:cli` (existing) → unpack the tarball into
   `desktop/resources/cli/`, **with a Node-ABI `better-sqlite3`** (§7).
3. **Assemble the Electron app dir** — main/preload (esbuild), `webapp/dist`
   (SPA), `webapp/dist-server` (server bundle), `@overlord/database` dist +
   migrations, the staged CLI.
4. **Rebuild native module for Electron ABI** — `electron-builder` /
   `@electron/rebuild` rebuilds `better-sqlite3` against the bundled Electron
   version. `asarUnpack` the `.node` and the migrations dir (read from disk).
5. **Package** — `electron-builder --mac dmg zip --<arch>` with
   `appId: io.cooperativ.openoverlord`, hardened-runtime entitlements (§6.4),
   icons, and the [shell plan's](desktop-app-module.md) electron fuses.
6. **Code sign** — `electron-builder` signs every nested binary
   (Electron Helpers, the `.node`, the staged CLI executables) with the
   **Developer ID Application** identity + hardened runtime + entitlements.
7. **Notarize** — `afterSign` hook runs `@electron/notarize` (→ `notarytool`)
   and **staples** the ticket to the `.app`/`.dmg`.
8. **Emit to `--out`** — copy the signed `.dmg` (+ `.zip` for auto-update later)
   and a `latest-mac.yml` into the operator's folder; print the artifact paths
   and `spctl`/`codesign --verify` results.

### 6.3 Signing credentials (env vars, so the script is headless)

The operator supplies these once (CI secret or shell profile); the script never
prompts:

| Variable | Purpose |
| --- | --- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application cert (`.p12`) + password (or it reads the login keychain) |
| `APPLE_TEAM_ID` | Team identifier for the signing identity |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | App Store Connect API key (`.p8`) for `notarytool` (preferred), **or** |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | Apple-ID-based notarization fallback |

`--no-sign` skips all of these and produces an ad-hoc-signed app (Gatekeeper
will warn; fine for local testing). The script validates that the required vars
are present before starting a `--sign` run and fails fast with a clear message.

### 6.4 Entitlements & Gatekeeper posture

The app **spawns child processes** (the server `utilityProcess`, and — via the
runner — agent CLIs and terminal windows through `osascript`, see
`cli/src/terminal-launcher.ts`) and **reads the user's repositories**. Therefore:

- **No App Sandbox.** Sandboxing would block reaching arbitrary project dirs,
  spawning `ovld`/agents, and Apple-Events terminal automation. Distribute via
  **Developer ID + notarization** (direct download), **not** the Mac App Store.
- **Hardened runtime** (required for notarization) with entitlements:
  - `com.apple.security.cs.allow-jit` and
    `com.apple.security.cs.allow-unsigned-executable-memory` — Electron/V8.
  - `com.apple.security.cs.disable-library-validation` — load the (separately
    signed) `better-sqlite3` `.node` and run the staged CLI.
  - `com.apple.security.automation.apple-events` — open iTerm2/Terminal via
    `osascript` for the launch path (TCC will still prompt the user once).
- Document that the **first agent launch** triggers a macOS automation consent
  prompt; this is expected and is a one-time per-machine grant.

---

## 7. The CLI inside the bundle

Agents (Claude Code, etc.) invoke `ovld` as an **external** process, so the CLI
cannot rely on Electron's ABI. It needs its own Node-ABI `better-sqlite3` and a
runtime to execute under.

**v1 (recommended):** ship the packed `open-overlord-cli` (which already vendors
`@overlord/database` via `cli/scripts/vendor-database.mjs`) plus a **Node-ABI
`better-sqlite3`** under `Contents/Resources/cli/`. Provide an **"Install CLI"**
menu action (the VS Code "Install 'code' command" pattern) that symlinks
`ovld`/`overlord` into `/usr/local/bin` (or `~/.local/bin`), where the shim
exports `OVERLORD_SQLITE_PATH`/`OVERLORD_STORAGE_DIR` for the app-data DB. The
CLI still requires **system Node ≥20** (it already does — `cli/src/index.ts:40`).
Document Node as the one prerequisite for *agent* use; the **GUI itself needs
nothing** (Electron is self-contained).

**v2 (zero-dependency CLI):** compile the CLI to a **Node SEA** (Single
Executable Application) so `ovld` runs with no system Node. `better-sqlite3`'s
`.node` ships alongside the SEA and is `require`'d at runtime. More build
complexity; do it once the v1 shape is proven. This removes the last external
dependency and makes the download truly self-contained.

Either way the CLI and GUI share one DB (§5.3), so a launched agent's `ovld
protocol attach/update/deliver` shows up live in the window via the existing SSE
feed.

---

## 8. DX preservation & optionality (hard requirement)

- **New code is confined** to the `desktop/` workspace (created by the
  [shell plan](desktop-app-module.md)) + `scripts/build-desktop.ts` + the small,
  guarded changes in §5 (server boot path, storage-dir override, `ovld serve`).
  The §5 changes are **behaviour-preserving for the repo**: defaults stay
  repo-relative; packaged mode only kicks in when the new env/config is set.
- **Excluded from default scripts.** `desktop` is added to root `workspaces` but
  **not** to `build`/`dev`/`test`/`typecheck` aggregates. Electron +
  electron-builder are heavy, platform-specific dev deps; a contributor who never
  touches the desktop never installs them. Gate behind explicit
  `yarn desktop:*` scripts that fail with a helpful message if deps are absent.
- **One-way dependency.** `desktop` depends on `webapp`/`cli`/`database`; none of
  them may depend on `desktop`.
- **The Postgres/Railway path is untouched.** The desktop app forces SQLite by
  never setting `DATABASE_URL`; the adapter, auth, and Postgres migrations are
  irrelevant to the bundle. No change to `railway-postgres-deployment-recommendation.md`.

---

## 9. Contract impact

Packaging itself is a **distribution concern**, not a new interaction surface —
but two touchpoints ride on the **`0.6-draft`** bump already proposed by the
[shell plan](desktop-app-module.md) (§9: new `desktop` component +
`desktop-shell` conformance type). This plan adds:

1. **CLI config-location resolution gains an app-data fallback.** The CLI Layer
   "owns ... configuration file locations and formats (`overlord.toml`, ...)"
   (`CONTRACT.md` §3). Today resolution is cwd-walk-up only
   (`cli/src/config.ts` `findConfigPath`). Packaged mode adds a documented
   fallback to the OS app-data dir (`~/Library/Application Support/Overlord/
   overlord.toml`) and the `OVERLORD_STORAGE_DIR` override. This is an
   **additive** change to a boundary the CLI already owns — document it in
   `cli/docs/02-cli-first-product-surface.md` and the CLI config-key list in
   `CONTRACT.md` / `contract/components.yaml`. No version bump beyond `0.6`.
2. **`ovld serve` becomes a real, documented management command** (§5.2), used by
   repo, Railway, and desktop alike. Document in
   `cli/docs/02-cli-first-product-surface.md`. (`protocol-commands.yaml` is
   unaffected — `serve` is management, not protocol.)
3. **No DB-selection change.** SQLite-when-`DATABASE_URL`-unset is unchanged;
   the desktop is a consumer of the existing adapter contract. The
   `database`/`rest`/`auth`/`runner` ownership boundaries are unchanged.

Per `CLAUDE.md` + `CONTRACT.md` maintenance rules, the contract edits **land
before** the corresponding code, on the same `0.6-draft` change the shell plan
introduces.

---

## 10. Phased plan (slots onto the shell plan)

The [shell plan](desktop-app-module.md) defines Phases 0–5. This ticket
**realizes its Phase 5** and front-loads the SQLite portability work the shell
plan glossed over. Concretely:

- **P0 — SQLite portability (prereq, no Electron).**
  Implement `ovld serve` with create+migrate+seed-if-empty; add
  `OVERLORD_STORAGE_DIR`; make the server boot path create the DB instead of
  throwing. **Acceptance:** `OVERLORD_SQLITE_PATH=/tmp/x.sqlite ovld serve` on a
  clean machine creates, migrates, seeds, and serves — verified by signup →
  ticket → `ovld protocol attach/deliver` against that fresh DB.

- **P1 — Server bundle.**
  esbuild `webapp/server` → `webapp/dist-server/index.js` with `better-sqlite3`
  external. **Acceptance:** `node webapp/dist-server/index.js` serves the SPA +
  API with no `tsx`.

- **P2 — Electron runs the bundle.**
  Retarget `server-supervisor.ts` to `utilityProcess.fork(serverBundle)` with the
  app-data dir; first-run creates the DB under `userData`. **Acceptance:** an
  unsigned dev `.app` launches, creates the DB on first run, shows the UI, and a
  terminal-launched agent's protocol calls appear live.

- **P3 — CLI in the bundle + Install CLI.**
  Stage the packed CLI with a Node-ABI native build; "Install CLI" symlink
  pointed at the app-data DB. **Acceptance:** after Install CLI, a fresh terminal
  `ovld tickets` lists the same data the window shows.

- **P4 — `scripts/build-desktop.ts` + signing/notarization.**
  electron-builder mac dmg/zip, hardened-runtime entitlements, Developer-ID
  signing, `notarytool` notarization + staple, `--out` emission, credential env
  vars, `--no-sign` path. **Acceptance:** `yarn desktop:package --out <dir>
  --sign --notarize` emits a `.dmg` that passes `spctl -a -vvv` and launches on a
  second, clean Mac with no Gatekeeper block.

- **P5 — Polish (optional).**
  Universal binary; auto-update (`latest-mac.yml` + the emitted `.zip`); CLI as a
  Node SEA for a zero-dependency download.

---

## 11. Open decisions for the user

1. **Signing identity & notarization creds.** Confirm we use **Developer ID +
   notarization (direct download)** — *not* Mac App Store (sandbox would break
   spawning agents/terminals, §6.4). Need: the Developer ID Application cert and
   either an App Store Connect API key (preferred) or Apple-ID app-specific
   password. *Recommendation: Developer ID + ASC API key.*
2. **Arch target for v1.** `arm64`-only first (the common case), or build both
   arm64 + x64, or a universal DMG? *Recommendation: arm64 + x64 single-arch
   DMGs; defer universal.*
3. **CLI runtime dependency.** Accept **system Node ≥20** as the one prerequisite
   for *agent* CLI use in v1 (GUI needs nothing), with a **Node-SEA** zero-dep CLI
   as a P5 follow-up? *Recommendation: yes — ship faster, SEA later.*
4. **App identity / branding.** Confirm `appId` (`io.cooperativ.openoverlord`?),
   app name shown in the dock/DMG, and icon source.
5. **Server lifecycle in the packaged app.** Always supervise via
   `utilityProcess` (recommended for a download), or keep the shell plan's
   "connect-only" mode as a fallback for advanced users? *Recommendation:
   supervise; connect-only is a dev convenience, not a shipping mode.*

---

## 12. Risks & notes

- **First-run DB creation is load-bearing.** The current `throw`-if-missing
  behaviour (`webapp/server/db.ts:26`) is the single biggest blocker to a
  download-and-launch app. P0 must land and be tested on a *clean* machine.
- **Two native-module ABIs.** The embedded server uses the **Electron** ABI; the
  bundled CLI uses the **Node** ABI. The build must produce and sign **both**
  `better-sqlite3` binaries. Getting one wrong yields `ERR_DLOPEN_FAILED` (the
  error `database/src/launch-local.ts:97` already explains for the dev case).
- **Notarization is slow and fails loudly.** Budget for `notarytool` round-trips
  (minutes) and for the first-time entitlement/hardened-runtime iteration. Keep a
  fast `--no-sign` loop for everything except the final signed build.
- **TCC automation prompt.** The first agent launch prompts for Apple-Events
  control of the terminal app; document it so users don't read it as a failure.
- **Don't fork the SPA or the server.** The bundle must consume the *same*
  `webapp` build the repo uses; desktop-only behaviour stays behind the feature-
  detected `window.overlord` bridge (per the shell plan). Packaging glue lives in
  `desktop/` and `scripts/build-desktop.ts` only.
- **Contract-first.** The §9 contract edits land on the shell plan's `0.6-draft`
  bump *before* the code that depends on them.
</content>
</invoke>
