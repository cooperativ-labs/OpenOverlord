# coo:14 — SQL Studio settings toggle

## Summary

Added an admin-only SQL Studio toggle to **Workspace settings → General**. The setting is stored per workspace in `workspaces.settings_json.sqlStudioEnabled` and controls whether the local backend launches the external `sql-studio` process for the active workspace.

## Changes

- **Backend**
  - `webapp/server/rbac.ts` — load actor roles and enforce admin-only mutations.
  - `webapp/server/workspace-settings.ts` — read/write `sqlStudioEnabled` in workspace settings (falls back to `overlord.toml` when unset).
  - `webapp/server/sql-studio-manager.ts` — start/stop SQL Studio dynamically when the active workspace setting changes.
  - `webapp/server/workspaces.ts` — expose `sqlStudioEnabled` on `WorkspaceDto`; admin-only PATCH support.
  - `webapp/server/repository.ts` — include `roles` on `ProfileDto` for UI gating.
  - `webapp/server/index.ts` — boot SQL Studio from workspace setting instead of only `overlord.toml`.

- **Frontend**
  - `webapp/web/components/workspaces/workspace-settings/GeneralPage.tsx` — admin-only switch with status URL when running.

- **Contract**
  - `WorkspaceDto.sqlStudioEnabled`, `UpdateWorkspaceBody.sqlStudioEnabled`, `ProfileDto.roles`.

- **Tests**
  - `webapp/server/workspace-settings.test.ts` — RBAC seed + settings persistence.

## Usage

1. Sign in as a workspace **Admin**.
2. Open **Workspace settings → General**.
3. Toggle **Enable SQL Studio** (requires `sql-studio` on the server `PATH` or `sql_studio_binary` in `overlord.toml`).

Non-admin members do not see the toggle and receive `403 Admin role required` if they attempt the PATCH directly.
