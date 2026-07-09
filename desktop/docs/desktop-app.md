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
  `nodeIntegration: false`, `webSecurity: true`, `spellcheck: true`, and a
  `preload` exposed through `contextBridge`. These are non-negotiable.
- A loopback-scoped **CSP** applied via `session.webRequest.onHeadersReceived`:
  `default-src 'self'`, `script-src 'self'`, inline styles allowed,
  `connect-src 'self'` + the loopback `http`/`ws` origin, `object-src 'none'`,
  `frame-ancestors 'none'`. No remote origins (there is no Supabase/remote API).
- A **single-instance lock**: a second launch focuses the existing window.
- **External-navigation handling**: `will-navigate` and `setWindowOpenHandler`
  send any off-origin URL to the system browser; in-app navigation stays on the
  loopback origin.

### Title bar & native chrome (macOS)

On macOS the native title bar is removed (`titleBarStyle: 'hiddenInset'`) and the
traffic lights are inset at `{ x: 14, y: 14 }`, so the webapp's own top nav is the
title bar — there is no separate "Overlord" chrome strip above the UI. The SPA
*feature-detects* the shell (`window.overlord`) to make the nav header / sidebar
header a window-drag region (`-webkit-app-region`) and to reserve room under the
inset lights; in a browser those styles are inert. This stays within the shell's
ownership of the window baseline and uses only the existing `window.overlord`
bridge — it does not fork or modify the SPA.

The macOS window also sets `vibrancy: 'sidebar'` with a transparent
`backgroundColor` so the left sidebar column can show the native sidebar material.
The SPA sets `data-mac-desktop` on `<html>` and makes only `[data-slot="sidebar-inner"]`
transparent; main content (`SidebarInset`, setup/auth screens) stays opaque.
Vibrancy follows Electron `nativeTheme`, which the SPA keeps in sync with its
`overlord-theme` preference via `window.overlord.setNativeThemeSource()` so the
sidebar material respects the app's light/dark/system toggle (not just the OS
appearance).

A **native context menu** is registered on the renderer's `context-menu` event
(`registerNativeContextMenu`). Because the renderer is sandboxed with no Node
access, the shell supplies the OS-native menu: in editable fields it offers
spellcheck suggestions (from `spellcheck: true`) plus undo/redo/cut/copy/paste/
select-all; over a plain text selection it offers copy/select-all; elsewhere it
stays out of the way.

## 3. Process lifecycle

1. On `app.whenReady`, claim a free loopback port (starting at `web_port`,
   default 4310).
2. Show a splash window (`splash.html`).
3. Fork the bundled server (`backend/dist-server/index.cjs`) inside an Electron
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
| `writeProjectMetadata(payload)` | write `.overlord/project.json` for a locally linked checkout after the backend resource is created |
| `openExternal(url)` | open an http(s) URL in the system browser |
| `revealInFinder(path)` | reveal a path in the OS file manager |
| `setNativeThemeSource(source)` | mirror the SPA theme (`light` / `dark` / `system`) to Electron `nativeTheme` for macOS vibrancy |
| `updates.getStatus()` | current update state |
| `updates.check()` | check the configured update feed |
| `updates.install()` | install a downloaded update and relaunch |
| `updates.onStatus(callback)` | subscribe to update state changes |
| `cliUpdates.getStatus()` | current CLI update state |
| `cliUpdates.check()` | check the installed CLI against npm |
| `cliUpdates.update()` | run `ovld update` from the shell |
| `cliUpdates.onStatus(callback)` | subscribe to CLI update state changes |
| `quickTask.getHotkey()` | read the registered global quick-task shortcut |
| `quickTask.setHotkey(accelerator)` | change the global quick-task shortcut |
| `quickTask.close()` | hide the quick-task capture window |
| `quickTask.setHeight(height)` / `quickTask.setBounds({ height, barOffsetTop })` | resize the frameless quick-task window |
| `quickTask.onShown(callback)` | run when the quick-task window is shown (e.g. reset focus) |

No tokens, Node access, or product logic cross this boundary.

### Backend profiles and CLI auth

The shell can switch between a **local** embedded backend and one or more
**remote** cloud backends (Settings → Backend). Switching reloads the app and
uses a separate Electron session partition per profile.

- **Local profile:** signing in mirrors the session bearer into
  `~/.ovld/auth.json` so the CLI can reuse the same credentials. On startup (or
  when switching back to Local), the shell imports a matching `auth.json` session
  if the desktop profile has no saved token yet.
- **Remote profiles:** tokens stay in the desktop shell's encrypted store only.
  The CLI must authenticate separately with `ovld auth login` or a USER_TOKEN
  after `ovld config set cloud <url>`.
- **Config sync:** switching backends updates `~/.ovld/overlord.toml`
  (`backend_url`, `backend_mode`). That does not change CLI auth — run
  `ovld auth status` after a backend switch to verify URL and login state.

## 6.1 Quick task window

The desktop shell registers a global shortcut (default **Cmd+Shift+O** on macOS,
**Ctrl+Shift+O** elsewhere) that toggles a small always-on-top frameless window
loading `/quick-task` on the loopback origin. The SPA route renders
`QuickTaskBar`: a compact objective composer with project picker, agent/model
selection, optional attachments, and Enter / Cmd+Enter submit semantics. Window
position and hotkey preference persist in the shell's `settings.json` under the
app user-data directory.

## 6. Updates

The shell uses `electron-updater` for packaged-app updates. On startup it checks
the configured feed, then checks again every four hours. Updates download
automatically; installation is explicit through **Settings → Desktop** or the
native **Check for Updates...** / **Install Update and Relaunch** menu items.

Release builds can embed a generic update feed by setting
`OVERLORD_UPDATE_FEED_URL` when running `yarn desktop:package:prod`. The default feed
is [GitHub Releases](https://github.com/cooperativ-labs/OpenOverlord/releases/latest/download/)
(see `desktop/update-feed.ts`). Each release must publish the `.zip`, `.blockmap`,
and `latest-mac.yml` files emitted by electron-builder — `yarn desktop:publish`
uploads them automatically. In unsigned/dev builds without a feed, update checks
report as unavailable.

## 6.2 CLI updates

The shell checks whether the installed `ovld` CLI is behind the latest published
npm version on startup and every four hours, using `ovld update --check --json`.
It prefers the `ovld` binary on `PATH` (what terminal sessions use) and falls
back to the bundled CLI entry when packaged. When an update is available, the
SPA surfaces an in-app system notification with an **Update now** action (runs
`ovld update` in the main process) and a copyable `ovld update` command as a
fallback.

## 7. Launching agents

Launching is unchanged: the webapp's **Launch** button queues an
`execution_request`; an `ovld runner` claims it and `ovld launch` opens the agent
in the terminal profile stored on the local execution target (CLI-owned). The desktop may
supervise a runner so the button works with zero manual setup. The shell adds no
terminal configuration of its own.

## 8. Packaging

`scripts/build-desktop.ts` (`yarn desktop:package:prod`) stages the server bundle, SPA,
CLI, and a runtime-only `.env.prod`, then runs electron-builder:

- Targets: `dmg` + `zip` (mac, arm64 + x64), `AppImage` + `deb` (linux).
- Before electron-builder runs, the script deletes and recreates `desktop/release`
  so each package build starts from a clean release directory.
- `appId: io.cooperativ.overlord`, hardened runtime + entitlements
  (`build/entitlements.mac.plist`), no App Sandbox (the app spawns agents and
  reads repos).
- `better-sqlite3` is rebuilt for the Electron ABI and `asarUnpack`'d alongside
  `@overlord/database` (its SQL migrations are read from disk).
- Code signing uses the Developer ID Application identity (auto-discovered or
  `CSC_LINK`); notarization (`--notarize`) uses `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. `--no-sign` produces an ad-hoc
  build.
- `GEMINI_API_KEY` is required for `desktop:package:prod` so packaged builds
  ship with a default Gemini key, but the staged `.env.prod` is filtered to
  runtime keys only and excludes build-only secrets such as `APPLE_*`.
- `OVERLORD_UPDATE_FEED_URL` overrides the default GitHub Releases updater feed
  (`desktop/update-feed.ts`) and causes electron-builder to emit update metadata
  such as `latest-mac.yml`.

### Native module / toolchain notes

`better-sqlite3` is rebuilt for the Electron ABI by `@electron/rebuild` during
packaging, so the build machine needs:

- **`better-sqlite3` ≥ 12.10.1** — earlier 12.x releases fail to compile against
  Electron 42's V8 (`v8::External::New` gained a required third argument). 12.10.1
  builds against Electron 42 cleanly.
- **A node-gyp-compatible Python** — node-gyp's bundled gyp imports `distutils`,
  which was removed in Python 3.12. `yarn desktop:package:prod` uses `PYTHON` when
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
- "Install CLI" shim, Tailscale, feed window, connector/plugin auto-install.
  These remain CLI surfaces or future work.
