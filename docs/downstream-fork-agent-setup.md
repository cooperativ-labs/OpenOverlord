# Closed Downstream Fork Agent Setup Guide

This is the handoff document for an agent working in the closed downstream fork
of OpenOverlord. The downstream fork will carry closed modules for Overlord
Cloud, Overlord Lite, and the Overlord Mobile App. Start with Overlord Lite: an
Electron desktop app that wraps the existing webapp and ships with the CLI.

Use this guide as the execution script. Do not start by creating Electron files.
Start by preserving the upstream contract boundaries, then add the downstream
module behind those boundaries.

## Non-Negotiable Rules

1. Read `CONTRACT.md` before any code change.
2. Keep upstream OpenOverlord as a normal Git remote, not as a submodule.
3. Put downstream-owned behavior in downstream-owned modules.
4. Do not edit upstream registries or core tables to add closed behavior unless
   the contract is updated first.
5. If a change adds a new component, conformance type, interaction surface, CLI
   command, config key, REST route, database table, or closed vocabulary value,
   update `CONTRACT.md` and the relevant `contract/*.yaml` files before code.
6. Every shipped downstream component must have a `conformance-manifest.yaml`
   validated against `contract/conformance-manifest.schema.yaml`.
7. Keep Electron optional: a contributor who only works on upstream CLI, webapp,
   database, auth, connectors, or automations must not need Electron installed
   or built by default.

## Current Upstream Baseline

This guide is based on OpenOverlord contract version `0.7-draft`.

Read these files first in the downstream repo:

- `CONTRACT.md`
- `contract/components.yaml`
- `contract/extension-points.yaml`
- `contract/conformance-manifest.schema.yaml`
- `docs/upstream-adoption.md`
- `docs/custom-instance-setup.md`
- `planning/feature-plans/desktop-app-module.md`
- `planning/feature-plans/desktop-app-packaging.md`
- `README.md`

The current upstream preparation that matters for downstream work:

- The repo is contract-first. Component ownership and sanctioned interaction
  surfaces are in `CONTRACT.md` and `contract/components.yaml`.
- Customized downstream repos are expected to track upstream with a normal
  remote. See `docs/upstream-adoption.md`.
- Local SQLite now defaults to the per-user global path
  `~/.ovld/Overlord.sqlite`, with `OVLD_HOME` to relocate the global directory
  and `OVERLORD_SQLITE_PATH` to override the full file path.
- `overlord.toml` supports `database_path` and `database_url`.
  `database_url` feeds the shared adapter-selection point, `resolveAdapter()`,
  so auth and the service layer agree on SQLite vs PostgreSQL.
- `terminal_launcher` is parsed by the CLI and used by `ovld launch` and the
  runner. Built-in values include `iTerm2` and `Terminal`; other values are raw
  prefix commands.
- Downstream automations can load through `OVERLORD_AUTOMATIONS_MODULE` and
  register through `registerAutomation` / `registerAutomations`. Do not edit the
  upstream `builtInAutomations` array for closed automations.
- `.env.example` now documents runtime env overrides the downstream app should
  preserve: `OVERLORD_WEB_HOST`, `OVERLORD_WEB_PORT`,
  `OVERLORD_SQL_STUDIO_ENABLED`, `OVERLORD_SQL_STUDIO_HOST`,
  `OVERLORD_SQL_STUDIO_PORT`, `OVERLORD_SQL_STUDIO_BINARY`, and
  `OVERLORD_AUTOMATIONS_MODULE`.
- Connector, database extension, auth provider, REST module, and automation
  extension points already exist. Use them before proposing new surfaces.

Important current gaps:

- `ovld serve` is referenced in docs, but there is no `serve` command in
  `cli/src/commands.ts` yet.
- `webapp/server/db.ts` still throws when the SQLite file is missing. A
  packaged app needs first-run create, migrate, and seed behavior.
- The web server currently runs from TypeScript via `tsx`; a packaged app needs
  a plain JS server bundle or a CLI command that starts an already-built server.
- Local storage paths still resolve from the repo-local storage bucket rows.
  A packaged app needs an app-data storage root, for example via a downstream or
  upstreamed `OVERLORD_STORAGE_DIR` override.
- `contract/conformance-manifest.schema.yaml` does not yet include a client or
  desktop shell component type. Add this before shipping Overlord Lite.
- The planning docs are proposals, not implemented modules. Verify code before
  relying on a described command or file.

## Downstream Repository Shape

Use a downstream distribution fork with upstream as a remote:

```bash
git remote add upstream https://github.com/cooperativ-labs/OpenOverlord
git fetch upstream
git branch --track upstream-main upstream/main
git checkout -b distribution upstream/main
```

Recommended downstream module layout:

```text
cloud/          # Overlord Cloud, added when cloud work starts
lite/           # Overlord Lite Electron desktop app
mobile/         # Overlord Mobile App, added when mobile work starts
downstream/     # shared closed assets, release scripts, automations, branding
```

Use top-level siblings because OpenOverlord uses a flat module layout
(`auth/`, `automations/`, `cli/`, `database/`, `webapp/`, `connectors/`,
`mcp/`). Do not put closed product code inside upstream-owned module folders
unless the change is intentionally a core patch.

Branch model:

- `upstream-main`: tracks the public upstream exactly.
- `distribution`: long-lived closed downstream integration branch.
- `lite/<topic>`: topic branches for Overlord Lite work.
- `adopt/upstream-<date>`: temporary branches used to merge or rebase upstream
  into `distribution`.

For each upstream adoption, review in this order:

1. `CONTRACT.md` and `contract/*.yaml`
2. database migrations and schema docs
3. CLI, protocol, runner, REST, auth, connector, automations surfaces
4. downstream modules and conformance manifests
5. tests, packaging, and docs

## Contract Patch For Overlord Lite

Before adding `lite/src/*`, update the downstream contract.

Recommended downstream contract changes:

1. Bump the downstream contract version from `0.7-draft` to a downstream-labeled
   version such as `0.8-downstream.0` in `CONTRACT.md` and
   `contract/components.yaml`.
2. Add a `lite` component to the Component Registry.
3. Add a conformance `componentType` for client shells. Prefer `client-shell`
   over `desktop-shell` because the downstream repo will also have a mobile
   app. If you choose `desktop-shell`, document why it will not fit mobile.
4. Add `lite/conformance-manifest.yaml`.
5. Run `ovld contract check lite/conformance-manifest.yaml` once the checker
   exists; until then, validate manually against the schema.

Suggested `lite` component contract text:

```text
Stable identifier: lite

Owns:
- Electron shell lifecycle for Overlord Lite
- Loading the existing Overlord webapp in a hardened BrowserWindow
- Process supervision for the local web server and optional local runner
- Minimal preload bridge for desktop-only affordances
- Desktop packaging, signing, notarization, and CLI installation helper
- Product branding and closed distribution assets for Overlord Lite

Does NOT own:
- REST paths, request shapes, response shapes, or SSE behavior (rest)
- Database schema, migrations, or storage metadata (database)
- Protocol lifecycle or delivery payloads (protocol)
- CLI command semantics, connector setup, terminal configuration, or runner
  queue claiming (cli, connector, runner)
- Auth mechanism or permission result shape (auth)
- Built-in automation registry (automations)

Uses:
- Renderer to REST over loopback HTTP/SSE
- Shell to CLI via subprocess for `ovld` commands
- Shell to OS through Electron main/preload only for desktop capabilities
```

Suggested `lite/conformance-manifest.yaml`:

```yaml
contractVersion: "0.8-downstream.0"
componentType: client-shell
componentKey: lite
label: "Overlord Lite"
description: "Closed downstream Electron shell that wraps the OpenOverlord webapp and distributes the CLI."
clientShell:
  shell: electron
  loadsRestOrigin: "loopback"
  usesCliSubprocesses: true
  ownsPackaging: true
```

The schema does not currently have `clientShell`. Add that object to
`contract/conformance-manifest.schema.yaml` when you add the `client-shell`
enum value.

Do not add Cloud and Mobile to the contract until they have real shipped
surfaces. It is fine to reserve `cloud/README.md` and `mobile/README.md`, but
once they become components, repeat the same contract-first process.

## Overlord Lite Implementation Plan

### Phase 0 - Baseline And Guardrails

1. Create the downstream branch from upstream.
2. Read the contract and the files listed in this guide.
3. Capture the current upstream commit in `downstream/BASELINE.md`.
4. Confirm `git status --short` is clean before starting Lite work.
5. Decide the downstream contract version string.

Acceptance:

- The downstream repo has an upstream remote.
- A baseline note records upstream commit, downstream contract version, and
  intended Lite scope.

### Phase 1 - Contract And Scaffold

Files to add or edit:

- `CONTRACT.md`
- `contract/components.yaml`
- `contract/conformance-manifest.schema.yaml`
- `README.md`
- `package.json`
- `lite/package.json`
- `lite/README.md`
- `lite/tsconfig.json`
- `lite/conformance-manifest.yaml`

Rules:

- Add `lite` to root `workspaces`.
- Do not add Lite to root `build`, `test`, `typecheck`, or `dev` aggregates.
- Add explicit scripts only, for example:

```json
{
  "scripts": {
    "lite:dev": "yarn workspace @overlord/lite dev",
    "lite:build": "yarn workspace @overlord/lite build",
    "lite:package": "yarn workspace @overlord/lite package"
  }
}
```

Suggested `lite/package.json`:

```json
{
  "name": "@overlord/lite",
  "private": true,
  "type": "module",
  "description": "Overlord Lite desktop shell",
  "scripts": {
    "dev": "electron .",
    "build": "tsc --project tsconfig.json --noEmit",
    "package": "electron-builder --config electron-builder.yml"
  }
}
```

Acceptance:

- Root default scripts still work without building Electron.
- `lite/conformance-manifest.yaml` matches the downstream schema.
- README lists Lite as optional and downstream-owned.

### Phase 2 - Serve Path And First-Run Database

Overlord Lite needs a reliable way to start the local webapp from a packaged
app. The current upstream code is not enough because `ovld serve` is not
implemented and the server throws when the database file is missing.

Implement one shared boot path before Electron supervision:

1. Add a real `ovld serve` management command, or add a reusable server entry
   that Lite can import/fork without relying on `tsx`.
2. Resolve config with `loadConfig()`.
3. Apply `database_url` with `applyDatabaseEnv(config)`.
4. Resolve the database path with `resolveDatabasePath(config)`.
5. If SQLite is selected and the file does not exist, create directories, open
   the database, run migrations, and seed the initial workspace.
6. Start the Express webapp at `web_host` / `web_port`.
7. Preserve the existing webapp dev workflow.

For packaged Lite, use an app-data root:

```text
~/Library/Application Support/Overlord Lite/
  overlord.toml
  Overlord.sqlite
  storage/
  logs/
```

Environment to pass to every server, runner, and CLI child process:

```bash
OVLD_HOME="<app-data-root>"
OVERLORD_SQLITE_PATH="<app-data-root>/Overlord.sqlite"
OVERLORD_STORAGE_DIR="<app-data-root>/storage"
```

`OVERLORD_STORAGE_DIR` is not currently implemented upstream. Add it as an
additive storage override, or keep a downstream patch documented as a carried
core patch until it is upstreamed.

Acceptance:

- Starting the chosen serve path against an empty app-data directory creates,
  migrates, seeds, and serves.
- `GET /api/health` returns `{ "ok": true }`.
- `GET /api/meta` reports the same database path that the CLI will use.

### Phase 3 - Electron Shell

Create the minimal shell under `lite/src/`:

```text
lite/
  src/
    main.ts
    preload.ts
    ipc/
      app.ts
      filesystem.ts
    services/
      server-supervisor.ts
      runner-supervisor.ts
      cli-resolver.ts
  resources/
  electron-builder.yml
```

Security baseline:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- preload through `contextBridge`
- single-instance lock
- external-origin navigation opens in the system browser
- strict CSP scoped to the loopback origin and SSE/WebSocket needs

Do not fork the SPA. Load the existing webapp. Any desktop-only renderer
behavior must be behind feature detection, for example:

```ts
if (window.overlordLite?.chooseDirectory) {
  // desktop-only affordance
}
```

Start with connect-only mode if needed:

- User or developer starts the server manually.
- Lite loads `http://127.0.0.1:<web_port>/`.
- Lite polls `/api/health` and shows a waiting screen until ready.

Then add supervised mode:

- Lite starts the server process.
- Lite waits for `/api/health`.
- Lite starts a local runner if configured.
- Lite shuts down owned child processes on quit.

Acceptance:

- The Lite window renders the unmodified webapp.
- Refresh, deep links, and external links behave correctly.
- Closing Lite cleans up owned processes.

### Phase 4 - Launching Agents

Use the CLI/runner launch path. Do not port a large Electron terminal launcher
matrix unless the CLI path proves insufficient.

Current upstream support:

- `terminal_launcher` exists in `overlord.toml`.
- `ovld launch` accepts `--terminal <launcher>` and `--no-terminal`.
- The runner passes the configured launcher into `launchAgent()`.
- `cli/src/terminal-launcher.ts` resolves inline, Terminal.app, iTerm2, and raw
  prefix commands.

Recommended Lite behavior:

1. Let the existing webapp queue `execution_requests`.
2. Lite supervises `ovld runner start`.
3. The runner opens the configured terminal via `terminal_launcher`.
4. Advanced direct launch IPC may shell out to `ovld launch`, but it must not
   become the primary product path.

Acceptance:

```bash
ovld launch codex --ticket-id <ticket-id> --terminal iTerm2 --dry-run --json
ovld runner once --terminal iTerm2 --dry-run --json
```

Both commands should show a terminal execution plan without starting a real
agent. From the Lite UI, clicking Launch should queue work that the supervised
runner claims.

### Phase 5 - CLI Distribution

Overlord Lite should ship the CLI along with the GUI.

Recommended v1:

1. Use `yarn pack:cli` to produce the CLI package.
2. Stage the packed CLI under the Lite app resources.
3. Add an "Install CLI" menu item that symlinks `ovld` / `overlord` into
   `/usr/local/bin` or `~/.local/bin`.
4. The shim must export the same app-data env used by the GUI:

```bash
export OVLD_HOME="<app-data-root>"
export OVERLORD_SQLITE_PATH="<app-data-root>/Overlord.sqlite"
export OVERLORD_STORAGE_DIR="<app-data-root>/storage"
exec "<bundled-cli>/bin/ovld.mjs" "$@"
```

Node 20 is already a CLI prerequisite. Accept system Node for v1 unless product
requirements demand a zero-dependency CLI. A future v2 can investigate Node SEA.

Acceptance:

- After installing the CLI, a new terminal running `ovld config list` points at
  the same database the Lite window shows.
- An agent launched outside Electron can run `ovld protocol attach/update/deliver`
  and the events appear live in Lite.

### Phase 6 - Packaging And Signing

Add `lite/electron-builder.yml` and a downstream package script. Keep signing
credentials in environment variables.

Suggested command interface:

```bash
yarn lite:package --out ~/Desktop/overlord-lite-dist --arch arm64 --sign --notarize
yarn lite:package --out ./build --no-sign
```

Recommended macOS distribution:

- Developer ID Application signing
- notarization with `notarytool`
- no Mac App Store sandbox for v1, because Lite launches terminals, agents, and
  reads arbitrary local repositories
- hardened runtime with the Electron entitlements needed for V8, native modules,
  and Apple Events if Terminal.app or iTerm2 launching uses AppleScript

Packaging must include:

- Electron main/preload bundle
- webapp static build
- server runtime or `ovld serve` target
- database migrations
- native `better-sqlite3` build for the runtime actually loading it
- staged CLI and connector assets
- icons, entitlements, and Info.plist metadata

Acceptance:

- An unsigned local build runs on the build machine.
- A signed/notarized build passes `spctl -a -vvv`.
- A clean Mac can launch Lite, create its first database, open the webapp, and
  install/run the CLI.

### Phase 7 - Closed Automations

If Lite needs downstream-only automations, do not edit
`automations/src/registry.ts`.

Create a downstream module such as:

```text
downstream/automations/
  package.json
  src/index.ts
```

Register automations at import time:

```ts
import { registerAutomations } from '@overlord/automations';

registerAutomations([
  {
    id: 'cooperativ:lite-triage',
    label: 'Lite Triage',
    description: 'Closed downstream automation for Overlord Lite.',
    run: async () => null
  }
]);
```

Set:

```bash
OVERLORD_AUTOMATIONS_MODULE=@cooperativ/overlord-downstream-automations
```

Rules:

- Use namespaced automation ids.
- Do not read or write domain tables from automation code.
- Use caller-supplied store interfaces for persistence.
- Return `null` when an optional provider is unavailable; callers must have
  deterministic fallbacks.

## What Not To Do

- Do not fork the React SPA for Lite. Wrap it.
- Do not put terminal settings in Electron-owned config. The CLI owns
  `terminal_launcher`.
- Do not make root `yarn build` or `yarn test` require Electron.
- Do not add downstream automations to the upstream built-in registry.
- Do not write directly to core tables from Lite, Cloud, Mobile, REST
  extensions, or automations.
- Do not add non-namespaced metadata or vocabulary values.
- Do not assume documentation describes implemented code. Verify the command or
  API in source before depending on it.
- Do not silently carry core patches. Document owner, reason, affected contract
  component, and exit strategy.

## Verification Matrix

Run the smallest checks that prove each boundary still works:

```bash
yarn build:db
yarn build:auth
yarn build:automations
yarn build:cli
yarn build:webapp
yarn workspace @overlord/lite build
```

CLI and config:

```bash
ovld init
ovld config list
ovld doctor
ovld launch codex --ticket-id <ticket-id> --terminal iTerm2 --dry-run --json
```

Webapp:

```bash
curl -sS http://127.0.0.1:4310/api/health
curl -sS http://127.0.0.1:4310/api/meta
```

Runner:

```bash
ovld runner status
ovld runner once --dry-run --json
```

Protocol:

```bash
ovld protocol attach --ticket-id <ticket-id>
ovld protocol update --ticket-id <ticket-id> --summary "Smoke test" --phase execute
ovld protocol deliver --ticket-id <ticket-id> --summary "Smoke test complete"
```

Conformance:

```bash
ovld contract check lite/conformance-manifest.yaml
```

If a command does not exist yet, treat that as implementation work, not a
reason to bypass the boundary.

## Prompt To Give The Downstream Agent

Use this prompt when handing off the downstream setup:

```text
You are working in the closed downstream fork of OpenOverlord. Read
CONTRACT.md and docs/downstream-fork-agent-setup.md first. Set up Overlord Lite
as a downstream-owned Electron client shell that wraps the existing webapp and
ships the CLI. Preserve upstream module boundaries. Start with the contract
patch and scaffold before writing Electron implementation code. Do not add Lite
to default root build/test scripts. Use the existing CLI/runner
terminal_launcher path for agent launches. Verify every current-code assumption
before relying on docs, especially ovld serve and first-run DB behavior.
```
