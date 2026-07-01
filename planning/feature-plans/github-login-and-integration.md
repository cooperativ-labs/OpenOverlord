# GitHub Login and GitHub Integration — Implementation Plan

Mission: `coo:69` — *add login with github and github integration*

Date: 2026-06-30

## TL;DR

1. **Add GitHub as a Better Auth social provider** for interactive login (web + desktop + cloud). Keep email/password as a parallel path; do not introduce a second identity system.
2. **Treat “GitHub integration” as a separate workspace capability** from login: a server-side GitHub API client (GitHub App preferred) that can link repos to projects and create/list PRs for published mission branches. Follow the Everhour integration shape: secrets on the server, DTOs in `packages/contract`, routes under `/api/integrations/github`, UI in Settings → Integrations.
3. **Ship in three phases**: (A) GitHub login, (B) workspace GitHub connect + repo link, (C) mission PR workflows replacing the copy-only `gh pr create` affordance.
4. **Desktop remote OAuth** needs a redirect round-trip (`overlord://` custom protocol or loopback callback) so bearer tokens land in the correct backend partition — already anticipated in `planning/feature-plans/overlord-cloud-architecture.md`.

---

## Problem statement

Overlord Cloud needs a low-friction way for humans to sign in without inventing a local username/password, and mission workflows already assume Git hosting (branch publish, PR creation) but today only surface a **copied `gh` CLI command** — there is no server-side GitHub linkage, no repo picker, and no in-product PR creation.

Today:

| Area | Current state |
| --- | --- |
| Interactive auth | Better Auth with `emailAndPassword` only; usernames are synthetic `<name>@overlord.local` emails (`auth/src/auth/config.ts`, `webapp/web/components/auth/AuthScreen.tsx`). |
| Identity bridge | DB trigger creates `profiles` on Better Auth `user` insert; `ensureWorkspaceUser()` in `backend/auth.ts` provisions `workspace_users` + `ADMIN` on first authenticated request. |
| Bearer / remote | Bearer plugin + `set-auth-token` header; desktop persists per-backend session tokens (`webapp/web/lib/api-base.ts`). |
| GitHub product surface | `MissionBranchControl` shows `gh pr create …` for copy/paste when a branch is `published`; no GitHub API calls. |
| Integration precedent | Everhour: workspace key in `workspaces.settings_json`, proxied REST routes, `IntegrationsPage` UI, DTOs in `packages/contract`. |

Goals for this mission:

- **Login with GitHub**: one-click sign-in/sign-up using GitHub as an OAuth identity provider, same RBAC and `Actor` resolution as email login.
- **GitHub integration**: workspace-level connection that enables repo linking and PR operations from the mission branch panel (and future automation), without exposing tokens to the browser.

Non-goals for v1:

- Org-wide member invites / SSO beyond GitHub OAuth.
- Replacing local git execution (branch commit/push still runs on the execution target).
- GitHub Issues ↔ mission bidirectional sync (defer; note as Phase 4+).
- Requiring GitHub login to use Local edition offline.

---

## Architecture decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Login provider | Better Auth `socialProviders.github` | Already mandated in cloud architecture doc; `account` table exists; no second IdP. |
| Login vs integration credentials | **Separate** OAuth apps / token stores | Login needs minimal scopes (`user:email` is **required** by Better Auth). Repo/PR work needs `repo` or a GitHub App installation token. Mixing scopes on the login token complicates consent and least-privilege. |
| Integration auth model | **GitHub App** (workspace installation) | Supports org repos, fine-grained permissions, webhooks later, and avoids per-user PAT management. Fallback: OAuth user token via `authClient.linkSocial({ provider: 'github', scopes: ['repo'] })` — reuses Better Auth's `account` token store, so no separate token table needed for the MVP fallback. |
| Same GitHub App for login + integration? | **No — keep login as an OAuth App (or a dedicated login GitHub App)** | If a single GitHub App were used for login too, its *Account Permissions → Email Addresses* must be set to Read-Only or logins fail with `email_not_found` (Better Auth doc). Separate apps keep the email-permission requirement isolated to the login app and repo permissions isolated to the integration app. |
| Secret storage | Env vars for app credentials; installation id + encrypted token metadata in `workspaces.settings_json` or `ext_github_*` table | Matches Everhour pattern (no secrets in DTOs); schema contract already allows namespaced `settings_json` keys. |
| API surface | `/api/integrations/github/*` on REST layer | Same module boundary as Everhour; auth-gated; service-layer persistence. |
| Desktop OAuth | Custom protocol `overlord://auth/callback` **or** loopback `http://127.0.0.1:<port>/auth/callback` forwarded into the active backend partition | Cross-origin cloud login cannot rely on cookies alone; bearer capture already exists. |
| Profile handle for GitHub users | Use GitHub login as `user.name` / `profiles.handle` when no local username was chosen | Existing trigger mirrors `user.name` → `handle`. Validate GitHub handle charset (broader than `validateLocalUsername`). |
| Account linking | Better Auth account linking, **but do NOT add `github` to `trustedProviders`** | Better Auth doc warns trusted providers auto-link on same email *even when the provider hasn't confirmed email verification* → account-takeover risk. Rely on default (verified-email) implicit linking; consider `disableImplicitLinking: true` to force explicit link from Account settings. Leave `allowDifferentEmails` and `allowUnlinkingAll` at defaults. |
| Local edition | GitHub login **optional**; disabled when `GITHUB_CLIENT_ID` unset | Preserves zero-config Local; Cloud/Railway enables via env. |

---

## Phase A — GitHub login (Better Auth social provider)

### A.1 Auth layer (`auth/`)

**Files:** `auth/src/auth/config.ts`, new `auth/providers/github/conformance-manifest.yaml` (sanctioned `auth-provider` extension point per `auth/AGENTS.md`).

1. Extend `createAuth()` (learnings from Better Auth GitHub doc):
   ```ts
   socialProviders: {
     github: {
       clientId: process.env.GITHUB_CLIENT_ID as string,
       clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
       // scope: user:email is REQUIRED — Better Auth cannot resolve the
       // account without it. Keep scopes minimal (no repo scope on login).
       mapProfileToUser: (profile) => ({
         name: profile.login,            // prefer GitHub login for user.name → profiles.handle
         email: profile.email,           // may be null when primary email is private (see step 4)
         image: profile.avatar_url,
       }),
     },
   }
   ```
   Gate on env presence so Local builds without GitHub creds behave unchanged.

2. Set `baseURL` / `BETTER_AUTH_URL` consistently for Cloud (already `https://…railway.app` in `.env.prod.example`). Callback path is fixed by Better Auth as `<baseURL>/api/auth/callback/github` (adjust if the auth route base path is customized). Register it on the GitHub OAuth App:
   - Cloud API: `https://<backend>/api/auth/callback/github`
   - Local dev: `http://127.0.0.1:4310/api/auth/callback/github` (and Vite dev origin in `trustedOrigins`).

3. Configure **account linking** (Better Auth `account.accountLinking`): rely on default verified-email implicit linking so an email/password user can attach GitHub. **Do not** list `github` in `trustedProviders` (auto-links unverified emails → takeover risk). Optionally set `disableImplicitLinking: true` to require explicit linking from Account settings.

4. **Private-email handling** (`email_not_found`): GitHub users with a private primary email return no email, and Better Auth's identity bridge (and our `profiles.email`) depends on it. Ensure the login OAuth App / GitHub App is granted email read (for a GitHub App: *Account Permissions → Email Addresses → Read-Only*), and use `mapProfileToUser` as the fallback path. Decide behavior when email is still absent (block with actionable error vs. synthesize a `noreply` handle-based email) — track as an open question.

5. Identity bridge: no change to `getActorForSession` — still `profiles.id = user.id`. Verify DB trigger populates `profiles.email` from GitHub email and `handle` from GitHub login.

6. First-login provisioning: `ensureWorkspaceUser()` already runs on session auth — confirm it executes after GitHub sign-up the same as email sign-up.

7. Tests (`auth/docs/testing.md`):
   - Mock Better Auth session for a GitHub-origin user → `Actor` resolves.
   - Profile row created with GitHub login as handle.

### A.2 REST / backend (`backend/auth.ts`)

- Confirm `trustedOrigins` includes Vercel preview/production web origins when `OVERLORD_WEB_DEV_PORT` / allowlist env is set (`backend/browser-origins.ts`).
- Expose `GET /api/meta` (or extend existing meta) with `authProviders: { github: boolean, email: boolean }` so UI can show/hide buttons without hardcoding Cloud.

### A.3 Web UI (`webapp/web/components/auth/`)

**Files:** `AuthScreen.tsx`, `auth-client.ts`, optional `GitHubSignInButton.tsx`.

1. Add **“Continue with GitHub”** primary action above the email/password form when `meta.authProviders.github`.
2. Call `authClient.signIn.social({ provider: 'github', callbackURL: … })`.
   - **Web (Vercel)**: callback returns to the webapp origin; session cookie or bearer per existing remote rules.
   - **Desktop local**: same-origin loopback — standard redirect.
   - **Desktop remote**: open system browser → OAuth → deep link or loopback handler → `persistAuthSessionFromSignInResult`.
3. Adjust copy: “Sign in with username” vs “Continue with GitHub” — do not force `@overlord.local` mental model when GitHub is available.
4. `AccountPage`: list linked providers via `authClient.listAccounts()`; offer link/unlink with `authClient.linkSocial({ provider: 'github' })` / `authClient.unlinkAccount({ providerId: 'github' })`. Hide password change if account is GitHub-only (guard against unlinking the sole account — Better Auth blocks this unless `allowUnlinkingAll`).

### A.4 Desktop shell (`desktop/`)

**Contract impact:** Desktop Shell section — OAuth redirect handling (already noted in cloud architecture plan).

1. Register `overlord://` protocol handler (or document loopback-only approach).
2. On callback, resolve active backend profile, persist bearer via existing `safeStorage` path, reload SPA partition.
3. Ensure external browser opens for OAuth (existing navigation guard sends external URLs to system browser — verify OAuth authorize URL is not blocked).

### A.5 Configuration & ops

**Env (document in `.env.prod.example`, `.env.local.example`):**
```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
# Optional: restrict login to an org — defer
```

**GitHub OAuth App settings (human setup checklist):**
- Homepage URL: Vercel deployment URL
- Callback URL(s): backend `/api/auth/callback/github` for each environment

### A.6 Acceptance criteria (Phase A)

- [ ] New user can sign up with GitHub on Cloud; lands in app with `workspace_users` + `ADMIN`.
- [ ] Returning GitHub user can sign in; bearer token works for API calls on desktop remote.
- [ ] Email/password login still works when GitHub env vars unset (Local).
- [ ] Profile `handle` matches GitHub login; avatar optional in `profiles.metadata_json` (`github.avatar_url`).
- [ ] No GitHub client secret or access token in browser network tab (login uses server-side OAuth code exchange).

---

## Phase B — Workspace GitHub integration (connect + repo link)

### B.1 Data model

**Preferred (GitHub App):** extension table to avoid overloading `settings_json`:

```
ext_github_installations (
  id, workspace_id, github_installation_id, github_account_login,
  permissions_json, status, created_at, updated_at, deleted_at, revision
)

ext_github_repo_links (
  id, workspace_id, project_id, github_repo_id, full_name,
  default_branch, metadata_json, …
)
```

Migration: `database/{sqlite,postgres}/migrations/20260630120000_ext_github.sql` with `component = 'ext:github'`.

**Lighter MVP alternative:** namespaced keys in `workspaces.settings_json`:
- `overlord.github.installationId`
- `overlord.github.accountLogin`
- Per-project: `projects.settings_json.overlord.githubRepo` (`owner/name`)

Update `database/docs/09-database-schema-contract.md` for promoted keys if stored on core tables.

### B.2 Backend module (`backend/github.ts` — mirror `everhour.ts`)

Responsibilities:

| Function | Purpose |
| --- | --- |
| `getGitHubIntegration()` | DTO: `{ connected, accountLogin, installationId? }` — no secrets |
| `beginGitHubAppInstall()` | Return GitHub App install URL (or OAuth URL for fallback) |
| `completeGitHubInstall(state)` | Validate state, persist installation id |
| `disconnectGitHub()` | Revoke / clear installation |
| `listAccessibleRepos()` | For project settings picker (paginated) |
| `linkProjectRepo(projectId, fullName)` | Store link; validate repo reachable |
| `unlinkProjectRepo(projectId)` | Clear link |

Implementation notes:

- Use `@octokit/rest` or `@octokit/auth-app` (add dependency to `backend/package.json` only).
- App credentials: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_APP_SLUG` env vars.
- Generate short-lived installation access tokens server-side per request (cache in memory with expiry buffer).
- All GitHub errors → `ApiError` with actionable messages (403 private repo, 404, rate limit).
- **OAuth-fallback path (no GitHub App):** obtain a user token by having the user run `authClient.linkSocial({ provider: 'github', scopes: ['repo'] })`, then read it server-side from the Better Auth `account` table. GitHub issues **no refresh token** and its access tokens are effectively long-lived (revoked or after 1yr unused), so no refresh loop is needed. Better Auth does **not** encrypt account tokens by default — add a `databaseHooks.account.create.before` (and `update.before`) hook to encrypt `accessToken` before storage, reusing `redactSecrets`/crypto helpers. Prefer the GitHub App path so Overlord never persists a user repo token at all.

### B.3 REST routes (`backend/index.ts`)

Mirror Everhour naming:

```
GET    /api/integrations/github
POST   /api/integrations/github/install        # returns { installUrl }
DELETE /api/integrations/github
GET    /api/integrations/github/repos          # ?q= search
PUT    /api/projects/:id/github-link           # { repoFullName } | null
GET    /api/projects/:id/github-link           # linked repo metadata
```

Permissions:
- `WORKSPACE_UPDATE` for install/disconnect
- `WORKSPACE_READ` for status
- `PROJECT_UPDATE` for repo link

DTOs in `packages/contract/src/index.ts` (`GitHubIntegrationDto`, `LinkProjectGitHubBody`, `GitHubRepoSummaryDto`).

### B.4 Web UI

**Files:** `webapp/web/components/settings/IntegrationsPage.tsx`, new `webapp/web/components/projects/project-settings/GitHubPage.tsx` (or section on General).

1. **Integrations card “GitHub”**:
   - Disconnected: “Install GitHub App” → redirect to GitHub → return URL completes install.
   - Connected: show `accountLogin`, Disconnect.
2. **Project settings** (when workspace connected):
   - Repo combobox (search `listAccessibleRepos`).
   - Show linked `owner/name` + default branch.
3. Gate mission GitHub features on `project.githubRepoFullName` (or equivalent DTO field on `ProjectDto`).

### B.5 Acceptance criteria (Phase B)

- [ ] Admin can install GitHub App on a workspace; status shows connected account.
- [ ] Admin can link an Overlord project to `cooperativ-labs/OpenOverlord` (example).
- [ ] Non-admin cannot install/disconnect (403).
- [ ] Disconnect clears repo links or marks them inactive with clear UI error.
- [ ] Secrets never appear in API responses or browser storage.

---

## Phase C — Mission PR workflows

### C.1 Behavior

Replace copy-only PR command in `MissionBranchControl` when GitHub is linked:

| Branch state | Today | Target |
| --- | --- | --- |
| `published` | Show `gh pr create …` copy button | **“Open pull request”** button → `POST /api/missions/:id/github/pull-request` |
| PR exists | — | Show link to GitHub PR; optional status badge |

Server flow:

1. Load mission branch metadata (`branch.name`, `baseBranch`, publish state).
2. Resolve project’s linked `owner/name`.
3. Call GitHub API `POST /repos/{owner}/{repo}/pulls` with `head` = branch name, `base` = parent branch, `title` derived from mission title (or prompt user in modal).
4. Persist `missions.metadata_json.overlord.githubPullRequest` (`number`, `url`, `createdAt`) — **or** new column if promoted to core (`missions.github_pull_request_url`).

Optional: detect existing PR for `head` branch via `GET /pulls?head=…` before creating.

### C.2 REST

```
POST /api/missions/:id/github/pull-request   # body: { title?, body?, draft? }
GET  /api/missions/:id/github/pull-request   # { url, number, state } | null
```

Requires `MISSION_UPDATE`; GitHub token via workspace installation.

### C.3 UI (`MissionBranchControl.tsx`)

- If project linked + branch `published`: show **Create PR** (and loading/error states).
- If PR metadata present: show **View PR** external link (desktop opens in system browser).
- Keep `gh pr create` copy as fallback when integration not configured (Local / no App).

### C.4 Acceptance criteria (Phase C)

- [ ] Published mission branch → one click creates PR on linked repo (smoke test against test repo).
- [ ] Duplicate create is idempotent (returns existing PR).
- [ ] Mission without linked repo still shows CLI fallback only.
- [ ] GitHub API failure surfaces readable error in branch panel.

---

## Cross-cutting concerns

### Security

- Store only installation ids and non-secret metadata in DB; mint tokens on demand.
- Validate OAuth `state` on all install callbacks.
- RBAC on every route; audit `actor_workspace_user_id` on link/unlink/PR create.
- Rate-limit GitHub proxy endpoints per workspace.
- Redact tokens in logs (reuse `redactSecrets` patterns).

### Contract maintenance

| Change | Contract action |
| --- | --- |
| GitHub login via Better Auth | No version bump (auth-provider extension point). |
| New REST paths + DTOs | Update `CONTRACT.md` REST API Layer + `packages/contract`. |
| `ext_github_*` tables | Extension manifest `componentType: database-extension`. |
| Desktop OAuth protocol | Update Desktop Shell interaction surface (as in cloud architecture §Contract impact). |
| Optional `missions.github_*` column | Schema contract + migration if promoted from metadata. |

### Testing strategy

| Layer | Tests |
| --- | --- |
| Auth | Session → Actor bridge with GitHub user fixture |
| GitHub module | Mock Octokit; install/link/PR happy paths + 403/404 |
| REST | Integration tests with mocked GitHub fetch |
| UI | Component tests for AuthScreen provider button; Integrations connect flow (MSW) |
| E2E (manual) | Cloud: GitHub login → link repo → publish branch → create PR |

### Drift / docs

After implementation, run drift-review skill across:
- `cli/README` (if `ovld auth login` mentions providers)
- `docs/getting-started.md`
- `webapp/docs/web-app.md` (deferred OAuth scope)
- Agent connector docs (no change expected)

---

## Suggested implementation order (objectives for follow-up work)

| # | Objective | Depends on |
| --- | --- | --- |
| 1 | Phase A backend + env + GitHub OAuth App setup | — |
| 2 | Phase A web AuthScreen + meta authProviders | 1 |
| 3 | Phase A desktop OAuth callback | 1, 2 |
| 4 | Phase B GitHub App install + REST + Integrations UI | 1 |
| 5 | Phase B project repo link UI + `ProjectDto` fields | 4 |
| 6 | Phase C mission PR create/view API + branch panel | 5 |
| 7 | Tests, contract doc updates, changelog | each phase |

Estimated relative size: **A ≈ 2–3 days**, **B ≈ 3–4 days**, **C ≈ 2 days** (single engineer, excluding GitHub App org approval delays).

---

## Open questions (resolve before Phase B/C coding)

1. **GitHub App vs OAuth user token for integration MVP** — App is recommended; confirm org can create/install app on `cooperativ-labs`.
2. **Multi-workspace future** — v1 assumes single seeded workspace per instance (current Cloud model); installation is workspace-scoped.
3. **Handle collisions** — GitHub login `foo` vs existing local username `foo`: rely on Better Auth linking + unique `profiles.handle` index; define UX error.
4. **PR author identity** — PRs created with installation token appear as the App bot unless `--author` / co-author semantics added later.
5. **Required GitHub scopes for private repos** — confirm App permissions: `contents:read`, `pull_requests:write`, `metadata:read`.
6. **Private GitHub email fallback** — when a user's primary email is private and `mapProfileToUser` still yields no email, block sign-in with an actionable message or synthesize a `<login>@users.noreply.github.com` address? (Affects `profiles.email` uniqueness and account linking.)
7. **Implicit vs explicit linking** — default same-email implicit linking (frictionless) or `disableImplicitLinking: true` (safer, forces link from Account settings)? Do not use `trustedProviders` either way.

---

## Better Auth GitHub — doc learnings (source of truth for Phase A)

Distilled from <https://better-auth.com/docs/authentication/github> and the accounts/linking concept doc (reviewed 2026-07-01):

| Learning | Impact on plan |
| --- | --- |
| `user:email` scope is **required**; only `clientId`/`clientSecret` are needed otherwise | Configure scope explicitly; keep login scopes minimal (no `repo`). |
| Callback path is `<baseURL>/api/auth/callback/github` (shifts with auth base path) | Register exactly this per environment; matches our REST mount. |
| `email_not_found` when GitHub App lacks email permission or user's primary email is private | Grant *Account Permissions → Email Addresses → Read-Only* on a login GitHub App; add `mapProfileToUser` fallback; decide no-email behavior (open Q6). |
| GitHub issues **no refresh token**; access tokens effectively long-lived | OAuth-fallback integration path needs no refresh loop. |
| Client APIs: `signIn.social({ provider, callbackURL })`, `listAccounts()`, `linkSocial({ provider, scopes })`, `unlinkAccount({ providerId })` | Drives AuthScreen + AccountPage; `linkSocial({ scopes:['repo'] })` is the Phase B OAuth fallback. |
| `account.accountLinking`: `enabled`, `trustedProviders`, `disableImplicitLinking`, `allowDifferentEmails`, `updateUserInfoOnLink`, `allowUnlinkingAll` | Use default verified-email linking; avoid `trustedProviders` (takeover risk); Better Auth blocks unlinking the sole account unless `allowUnlinkingAll`. |
| Provider tokens stored in `account` table, **unencrypted by default** | If we ever store a GitHub user token, add `databaseHooks.account.create.before` encryption. |

## References

- `auth/src/auth/config.ts` — Better Auth setup
- `backend/auth.ts` — session + `ensureWorkspaceUser`
- `backend/everhour.ts` — integration pattern
- `webapp/web/components/auth/AuthScreen.tsx` — login UI
- `webapp/web/components/MissionBranchControl.tsx` — PR copy command (`gh pr create`)
- `planning/feature-plans/overlord-cloud-architecture.md` — OAuth + bearer decisions
- `auth/AGENTS.md` — auth provider extension procedure
- `CONTRACT.md` — Auth Layer, REST Layer, Desktop Shell surfaces
- <https://better-auth.com/docs/authentication/github> — GitHub provider config (scopes, callback, `email_not_found`)
- <https://better-auth.com/docs/concepts/users-accounts> — account linking + token storage
