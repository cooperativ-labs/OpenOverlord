# `@overlord/desktop` — Desktop Shell (optional)

A thin **Electron** wrapper around the OpenOverlord web control center. It does
not reimplement product logic: it loads the unmodified `@overlord/webapp` SPA in
a hardened `BrowserWindow` over a loopback origin, supervises the local
REST/realtime server the SPA depends on, and gives Overlord a native app shell.

This module is **optional** and **excluded from the default `build` / `dev` /
`test` / `typecheck` aggregate scripts** — a contributor who never touches the
desktop never builds or tests it. It is a workspace (so `workspace:*` deps and
electron-builder's dependency analysis resolve), which means `yarn install` does
resolve its Electron dev-dependencies; set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
during install to skip the large Electron binary download if you are not using
the desktop. The dependency arrow points one way only: `desktop` depends on
`webapp`/`cli`/`database`; none of them depend on `desktop`.

Maps to the `desktop` contract component (`desktop/docs/desktop-app.md`).

## How it works

- **Window & security.** One `BrowserWindow` with `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, and a `preload` bridge. A loopback-scoped CSP,
  single-instance lock, and external-link handling (links open in the system
  browser). The renderer is the SPA, unchanged.
- **Server supervision.** On launch the main process forks the bundled server
  (`webapp/dist-server/index.mjs`) inside an Electron **`utilityProcess`** — a
  Node context on Electron's ABI, so there is a single runtime to ship and sign.
  It polls `/api/health`, then loads the URL. The server is stopped on quit.
- **Shared database.** The server uses its default database location (the
  per-user global `~/.ovld/Overlord.sqlite`), so an `ovld` run from a terminal
  shares the exact database the window shows — no extra wiring. The DB is created
  and migrated on first launch by the server boot path.
- **Bridge.** `window.overlord` exposes only shell-only affordances
  (`chooseDirectory`, `openExternal`, `revealInFinder`), which the SPA
  feature-detects and never requires.

## Scripts

```bash
# From the repo root (gated; `yarn install` once to pull the Electron deps):
yarn desktop:build         # build the SPA + server bundle + Electron main/preload
yarn desktop:dev           # connect-only: wraps a running `ovld serve` / `yarn start`
yarn desktop:typecheck     # typecheck the shell against the Electron type defs
yarn desktop:package --out <dir> [--arch arm64|x64|universal] [--no-sign] [--notarize]
```

### Dev loop (connect-only)

`yarn desktop:dev` does **not** fork the server (avoiding an Electron-ABI native
rebuild during development). Start a server first, then launch the shell:

```bash
yarn build:webapp && yarn workspace @overlord/webapp build:server
ovld serve            # serves the SPA + API at http://127.0.0.1:4310
yarn desktop:dev      # Electron window connects to it
```

Override the URL with `OVERLORD_DESKTOP_URL`.

## Packaging & signing

`yarn desktop:package` (→ `scripts/build-desktop.ts`) builds the modules + server
bundle + SPA, stages the CLI, and runs electron-builder to emit a signed,
notarized `.dmg`/`.zip` into `--out`. Signing/notarization credentials are read
from the environment (`.env` at the repo root):

| Variable | Purpose |
| --- | --- |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Developer Team ID |

The Developer ID Application signing identity is auto-discovered from the login
keychain (or set `CSC_LINK`/`CSC_KEY_PASSWORD`). Use `--no-sign` for an ad-hoc
local build that needs no Apple account. See
[`docs/desktop-app.md`](docs/desktop-app.md) for the full behavior spec and
[`docs/testing.md`](docs/testing.md) for the test plan.
