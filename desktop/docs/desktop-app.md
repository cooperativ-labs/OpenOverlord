# Desktop App — Behavior Spec

The behavior reference for the `desktop` contract component. The planning
rationale lives in
[`planning/feature-plans/desktop-app-module.md`](../../planning/feature-plans/desktop-app-module.md)
and
[`planning/feature-plans/desktop-app-packaging.md`](../../planning/feature-plans/desktop-app-packaging.md);
this document records what shipped.

## 1. What it is

An optional Electron shell that wraps the existing webapp. It owns the native app
shell and process supervision only — never product logic, REST/DTO shapes,
CLI/terminal config, the auth mechanism, or the DB schema (those belong to the
`rest`, `cli`/`runner`, `auth`, and `database` components respectively).

## 2. Window & security baseline

- A single `BrowserWindow` with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `webSecurity: true`, and a `preload` exposed through
  `contextBridge`. These are non-negotiable.
- A loopback-scoped **CSP** applied via `session.webRequest.onHeadersReceived`:
  `default-src 'self'`, `script-src 'self'`, inline styles allowed,
  `connect-src 'self'` + the loopback `http`/`ws` origin, `object-src 'none'`,
  `frame-ancestors 'none'`. No remote origins (there is no Supabase/remote API).
- A **single-instance lock**: a second launch focuses the existing window.
- **External-navigation handling**: `will-navigate` and `setWindowOpenHandler`
  send any off-origin URL to the system browser; in-app navigation stays on the
  loopback origin.

## 3. Process lifecycle

1. On `app.whenReady`, claim a free loopback port (starting at `web_port`,
   default 4310).
2. Show a splash window (`splash.html`).
3. Fork the bundled server (`webapp/dist-server/index.mjs`) inside an Electron
   **`utilityProcess`** with `OVERLORD_WEB_HOST`/`OVERLORD_WEB_PORT`/
   `OVERLORD_WEBAPP_DIST` set and SQL Studio disabled.
4. Poll `GET /api/health` until ready (30s budget), then load
   `http://<host>:<port>/`. On failure, show a Retry/Quit dialog.
5. On `before-quit`, stop the server. Closing the window quits the app.

The server is the **same bundle** `ovld serve` runs. Using a `utilityProcess`
(rather than a separate Node binary) means a single runtime is shipped, signed,
and notarized; `better-sqlite3` is rebuilt once for the Electron ABI.

### Connect-only dev mode

With `OVERLORD_DESKTOP_DEV=1` the shell does **not** fork a server; it connects
to an already-running one (`OVERLORD_DESKTOP_URL`, default
`http://127.0.0.1:4310`). This keeps the dev loop free of an Electron-ABI native
rebuild.

## 4. Database sharing

The embedded server is started with **no** `OVERLORD_SQLITE_PATH`, so it uses the
per-user global default (`~/.ovld/Overlord.sqlite`). Any `ovld` invoked from a
terminal uses the same default, so a launched agent's `ovld protocol
attach/update/deliver` shows up live in the window via the SSE feed — with no
"Install CLI" step required for the common single-machine case. The server boot
path **creates and migrates** the database on first run.

> Set `OVERLORD_SQLITE_PATH` in the environment to point the shell at an isolated
> app-data database instead; storage follows the database location automatically
> (`fixupLocalStoragePaths`).

## 5. The `window.overlord` bridge

A minimal, audited surface the SPA **feature-detects** (`if (window.overlord)`):

| Member | Purpose |
| --- | --- |
| `isDesktop` | `true` inside the shell |
| `platform` | `process.platform` |
| `version` | the app version |
| `chooseDirectory()` | native directory picker → absolute path or `null` |
| `openExternal(url)` | open an http(s) URL in the system browser |
| `revealInFinder(path)` | reveal a path in the OS file manager |
| `updates.getStatus()` | current update state |
| `updates.check()` | check the configured update feed |
| `updates.install()` | install a downloaded update and relaunch |
| `updates.onStatus(callback)` | subscribe to update state changes |

No tokens, Node access, or product logic cross this boundary.

## 6. Updates

The shell uses `electron-updater` for packaged-app updates. On startup it checks
the configured feed, then checks again every four hours. Updates download
automatically; installation is explicit through **Settings → Desktop** or the
native **Check for Updates...** / **Install Update and Relaunch** menu items.

Release builds can embed a generic update feed by setting
`OVERLORD_UPDATE_FEED_URL` when running `yarn desktop:package`. The release
directory must publish the `.zip`, `.blockmap`, and `latest-mac.yml` files
emitted by electron-builder at that feed URL. In unsigned/dev builds without a
feed, update checks report as unavailable.

## 7. Launching agents

Launching is unchanged: the webapp's **Launch** button queues an
`execution_request`; an `ovld runner` claims it and `ovld launch` opens the agent
in the terminal configured by `terminal_launcher` (CLI-owned). The desktop may
supervise a runner so the button works with zero manual setup. The shell adds no
terminal configuration of its own.

## 8. Packaging

`scripts/build-desktop.ts` (`yarn desktop:package`) stages the server bundle, SPA,
and CLI, then runs electron-builder:

- Targets: `dmg` + `zip` (mac, arm64 + x64), `AppImage` + `deb` (linux).
- `appId: io.cooperativ.openoverlord`, hardened runtime + entitlements
  (`build/entitlements.mac.plist`), no App Sandbox (the app spawns agents and
  reads repos).
- `better-sqlite3` is rebuilt for the Electron ABI and `asarUnpack`'d alongside
  `@overlord/database` (its SQL migrations are read from disk).
- Code signing uses the Developer ID Application identity (auto-discovered or
  `CSC_LINK`); notarization (`--notarize`) uses `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. `--no-sign` produces an ad-hoc
  build.
- `OVERLORD_UPDATE_FEED_URL` configures the generic updater feed and causes
  electron-builder to emit update metadata such as `latest-mac.yml`.

### Native module / toolchain notes

`better-sqlite3` is rebuilt for the Electron ABI by `@electron/rebuild` during
packaging, so the build machine needs:

- **`better-sqlite3` ≥ 12.10.1** — earlier 12.x releases fail to compile against
  Electron 42's V8 (`v8::External::New` gained a required third argument). 12.10.1
  builds against Electron 42 cleanly.
- **A node-gyp-compatible Python** — node-gyp's bundled gyp imports `distutils`,
  which was removed in Python 3.12. `yarn desktop:package` uses `PYTHON` when
  set, otherwise it auto-selects an installed `python3.11`/`python3.10`/`python3.9`
  /`python3.8` if the default Python cannot import `distutils`. If none is
  available, install Python 3.11 or `pip install setuptools` for the default
  Python.
- Xcode Command Line Tools (the C++ toolchain) for the compile.

A verified `--no-sign` arm64 + x64 build with Electron 42.4.0 produces
`Overlord-<version>-arm64.dmg` / `Overlord-<version>.dmg` (and matching `.zip`s).

## 9. Deferred (later phases)

- Better Auth login UI in the SPA (loopback stays single-trusted-operator by
  default; in-app auth would use Better Auth session cookies, spawned CLI a
  `USER_TOKEN`).
- "Install CLI" shim, Tailscale, quick-task/feed windows, connector/plugin
  auto-install. These remain CLI surfaces or future work.
