# `@overlord/desktop` — Desktop Shell (optional)

A thin **Electron** wrapper around the OpenOverlord web control center. It does
not reimplement product logic: it loads the unmodified `@overlord/webapp` SPA in
a hardened `BrowserWindow` over a loopback origin, supervises the local
REST/realtime server the SPA depends on, and gives Overlord a native app shell.

## Table of Contents

- [For Users](#for-users)
  - [What Desktop provides](#what-desktop-provides)
  - [Updates](#updates)
- [For Developers](#for-developers)
  - [Module scope](#module-scope)
  - [How it works](#how-it-works)
  - [Scripts](#scripts)
  - [Dev loop (connect-only)](#dev-loop-connect-only)
  - [Packaging & signing](#packaging--signing)
  - [Publishing releases](#publishing-releases)

## For Users

### What Desktop provides

Desktop is the native macOS app for Overlord. It supervises the local backend and
SQLite database, then loads the web control center in a hardened window. The
published `ovld` CLI talks to the same backend URL (by default
`http://127.0.0.1:4310`) and uses the same `/api/*` surface the SPA uses — you
do not need to run a separate server when Desktop is running.

Download packaged releases from
[GitHub Releases](https://github.com/cooperativ-labs/OpenOverlord/releases/latest).

### Updates

Release builds embed a generic electron-updater feed pointing at
[GitHub Releases](https://github.com/cooperativ-labs/OpenOverlord/releases/latest/download/)
(`latest-mac.yml` plus `.zip` / `.blockmap` assets). Installed apps check that
feed on startup and every four hours.

## For Developers

### Module scope

This module is **optional** and **excluded from the default `build` / `dev` /
`test` / `typecheck` aggregate scripts** — a contributor who never touches the
desktop never builds or tests it. It is a workspace (so `workspace:*` deps and
electron-builder's dependency analysis resolve), which means `yarn install` does
resolve its Electron dev-dependencies; set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
during install to skip the large Electron binary download if you are not using
the desktop. The dependency arrow points one way only: `desktop` depends on
`webapp`/`cli`/`database`; none of them depend on `desktop`.

Maps to the `desktop` contract component (`desktop/docs/desktop-app.md`).

### How it works

- **Window & security.** One `BrowserWindow` with `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, and a `preload` bridge. A loopback-scoped CSP,
  single-instance lock, and external-link handling (links open in the system
  browser). The renderer is the SPA, unchanged.
- **Server supervision.** On launch the main process forks the bundled server
  (`webapp/dist-server/index.mjs`) inside an Electron **`utilityProcess`** — a
  Node context on Electron's ABI, so there is a single runtime to ship and sign.
  It polls `/api/health`, then loads the URL. The server is stopped on quit.
- **Local backend and database.** The desktop-supervised server owns the local
  SQLite database and migrations. The published `ovld` CLI does not open this
  database directly; it points at the desktop/local backend URL (by default
  `http://127.0.0.1:4310`) and uses the same `/api/*` surface the SPA uses.
- **Bridge.** `window.overlord` exposes only shell-only affordances
  (`chooseDirectory`, `openExternal`, `revealInFinder`), which the SPA
  feature-detects and never requires.

### Scripts

```bash
# From the repo root (gated; `yarn install` once to pull the Electron deps):
yarn desktop:build:prod    # build the SPA + server bundle + Electron main/preload
yarn desktop:dev           # connect-only: wraps a running `ovld serve` / `yarn start`
yarn desktop:typecheck     # typecheck the shell against the Electron type defs
yarn desktop:package:prod [--out <dir>] [--arch arm64|x64|universal] [--no-sign] [--notarize]
yarn desktop:publish       # publish desktop/release artifacts to GitHub Releases via gh
```

### Dev loop (connect-only)

`yarn desktop:dev` does **not** fork the server (avoiding an Electron-ABI native
rebuild during development). Start a server first, then launch the shell:

```bash
yarn build:webapp:prod && yarn workspace @overlord/webapp build:server
ovld serve            # serves the SPA + API at http://127.0.0.1:4310 from a source checkout
yarn desktop:dev      # Electron window connects to it
```

Override the URL with `OVERLORD_DESKTOP_URL`.

### Packaging & signing

`yarn desktop:package:prod` (→ `scripts/build-desktop.ts`) builds the modules + server
bundle + SPA, stages the CLI, writes a runtime-only bundled `.env.prod`, and runs
electron-builder to emit a signed, notarized `.dmg`/`.zip` into `--out`.
Signing/notarization credentials are read from the environment (`.env.prod` at
the repo root):

Each packaging run deletes the existing `desktop/release` contents before
electron-builder writes the next release, so stale versioned artifacts do not
bleed into subsequent publishable builds.

| Variable | Purpose |
| --- | --- |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Developer Team ID |
| `OVERLORD_UPDATE_FEED_URL` | Override the default GitHub Releases update feed (see `desktop/update-feed.ts`) |

The packaging step requires `GEMINI_API_KEY` so the desktop app ships with a
default Gemini key, but it filters build-only secrets such as `APPLE_*` out of
the bundled `.env.prod`.

The Developer ID Application signing identity is auto-discovered from the login
keychain (or set `CSC_LINK`/`CSC_KEY_PASSWORD`). Use `--no-sign` for an ad-hoc
local build that needs no Apple account.

See
[`docs/desktop-app.md`](docs/desktop-app.md) for the full behavior spec and
[`docs/testing.md`](docs/testing.md) for the test plan.

### Publishing releases

To push the packaged desktop artifacts to GitHub Releases, run
`yarn desktop:package:prod` (artifacts land in `desktop/release` by default), then:

```bash
yarn desktop:publish
```

The publish script:

- infers the GitHub repo from `origin` unless you pass `--repo owner/name`
- defaults the release tag to `v<root package version>`
- uploads the current version's `.dmg`, `.zip`, `.blockmap`, `AppImage`, `deb`,
  and `latest-mac.yml` files from `desktop/release`
- creates the release with generated notes if it does not exist yet, or uploads
  replacement assets with `--clobber` if the tag already exists

Use `yarn desktop:publish --dry-run` to inspect the resolved release command
without changing GitHub.
