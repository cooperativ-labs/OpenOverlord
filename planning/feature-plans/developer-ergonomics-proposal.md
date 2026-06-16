# Proposal: Developer Ergonomics for the Modular Repo

Status: **proposal — no code changed**
Related: ticket 1:1485 delivery (database source-of-truth analysis), [`CONTRACT.md`](../CONTRACT.md), [`README.md`](../README.md)

## The problem, precisely

The repo presents itself as "independent modules connected via the contract," and the
*documentation* layout delivers on that (every module has a README, AGENTS.md, and
`docs/`). The *packaging* layout does not. Today there are **three disjoint Yarn
projects** — root, `cli/`, `webapp/` — each with its own `package.json`, `yarn.lock`,
and `.yarnrc.yml`, yet none of them is actually independent:

| Symptom | Evidence |
| --- | --- |
| webapp reaches across its package boundary | `webapp/server/title-automation.ts`, `repository.ts` import `../../src/...` from the root project with no declared dependency |
| CLI compiles root code into its own dist | `cli/tsconfig.build.json` sets `rootDir: ".."` and includes `../src/database/**`, `../src/service/**`, `../src/repository/git-tree.ts` |
| Migrations are hand-copied between packages | `cli/scripts/stage-migrations.mjs` copies `database/sqlite/migrations/` into `cli/database/`; the committed copy is already stale (see ticket 1:1485) |
| Dependency versions drift silently | `typescript` `^5.7.0` (root) vs `^5.7.2` (webapp); `tsx` `^4.22.4` (root) vs `^4.19.2` (webapp); `@types/node` only pinned in webapp |
| The native module compiles up to three times | `better-sqlite3` is a dependency of all three projects; each lockfile resolves and builds its own copy |
| Bootstrap is incomplete | root `install:all` runs root + webapp installs but **never installs `cli/`** — the CLI only works because Node's upward `node_modules` walk happens to find root's copies of `better-sqlite3` and `smol-toml` |
| Three configs to keep in sync | three `.yarnrc.yml` files with different settings (root approves all git repos; webapp pins `supportedArchitectures`; cli has neither) |
| Module folders and module code live in different places | the `auth`, `automations`, `database` *modules* are doc folders at the root, while their implementations live in `auth/src/auth`, `automations/src`, `src/database` |

So the current state is the worst of both worlds: the **overhead** of three packages
(three lockfiles, three installs, three resolution graphs) with **none of the
isolation** (relative-path imports across boundaries, a copy script standing in for a
dependency edge, root code compiled into the CLI tarball).

None of this violates `CONTRACT.md` — the contract governs *interaction surfaces*,
not packaging — but it does undermine the modular story the contract is meant to
support: a developer cannot tell from `package.json` files which module depends on
which, because the real edges are relative imports and a copy script.

## Question 1 — Should it be a monorepo?

**It already is one; make it official with Yarn workspaces.** The repo is a single
codebase with cross-folder imports and a single contract. What it is missing is the
tooling that makes that arrangement coherent.

Yarn 4 (already pinned via `packageManager: yarn@4.16.0`) supports workspaces
natively. The conversion is small:

```jsonc
// root package.json
{
  "workspaces": ["cli", "webapp", "database"]
}
```

- **One lockfile, one `.yarnrc.yml`, one `yarn install`** at the root. Delete
  `cli/yarn.lock`, `webapp/yarn.lock`, the per-package `.yarnrc.yml` files, and the
  `install:all` / `reinstall` / `new` script gymnastics. Merge webapp's
  `supportedArchitectures` block into the root `.yarnrc.yml` (it is what lets the
  same tree install on both the Linux pod and the macOS host).
- **`better-sqlite3` resolves once** and builds once, hoisted to the root.
- **Cross-module dependencies become declared edges.** `open-overlord-cli` and
  `@overlord/webapp` add `"@overlord/database": "workspace:*"` instead of reaching
  up with `../../src` or copying files. `yarn workspaces foreach --topological`
  then builds things in the right order for free.
- **Version drift becomes impossible by construction** for anything hoisted, and
  visible in one diff for anything that isn't.

### What this does *not* mean

- It does **not** mean adopting Nx/Turborepo/Lerna. The repo is three packages, not
  thirty; plain Yarn workspaces plus `yarn workspaces foreach` is enough, and adding
  a build orchestrator would itself be an ergonomics regression. Revisit only if
  build times become a problem.
- It does **not** weaken modularity. Modularity here is enforced by `CONTRACT.md`
  and conformance manifests, not by lockfile separation. Workspaces make the module
  graph *more* explicit, because every cross-module edge must appear in a
  `package.json`.
- It does **not** change how the CLI ships. `open-overlord-cli` is still packed and
  published from `cli/`; the difference is that its dependency on the database
  module travels through normal package resolution (bundled at pack time) instead
  of `stage-migrations.mjs`.

### The `@overlord/database` package (ties into ticket 1:1485)

The 1:1485 delivery recommended promoting `/database` into a real shared package
owning the migrations, adapters, and the connection runtime currently in
`src/database/`. Workspaces are the prerequisite that makes that recommendation
cheap: `/database` gains a `package.json` (`@overlord/database`), absorbs
`src/database/{connection,constants,launch-local}.ts`, and the CLI and webapp
depend on it. That deletes:

- `cli/scripts/stage-migrations.mjs` and the committed `cli/database/` copy
  (the drifting second source of truth),
- the `rootDir: ".."` reach in `cli/tsconfig.build.json` for database code,
- the duplicate-migration risk class entirely.

It is also the natural home for the single `resolveAdapter()` recommended in 1:1485
so the CLI runtime and `auth/src/auth/config.ts` stop sniffing `DATABASE_URL`
independently.

### Module folders vs `src/` (the deeper confusion)

A newcomer who reads "each module owns its code, tests, and documentation" and opens
`auth/` finds only docs; the code is in `auth/src/auth`. Same for `automations` and
`database`. This split — module *identity* at the root, module *implementation* in
`src/` — is the single most disorienting thing about the layout.

Recommendation: **converge on the module folders as packages, incrementally.**
`database` first (per 1:1485 — it has the clearest payoff). Then, only when a module
needs to be versioned or consumed independently, promote the next one
(`@overlord/auth` absorbing `auth/src/auth` + `auth/src/rbac` is the likeliest candidate).
Modules that are pure consumers of the service layer can stay in `src/`
indefinitely; the point is that *the README's module table should say where the
code lives*, and each promotion should remove one row of confusion rather than
restructure everything at once. A big-bang "every contract component becomes a
package" migration is explicitly **not** proposed — most of `src/service` is shared
plumbing with no independent consumers, and splitting it would manufacture version
boundaries nobody needs.

## Question 2 — Should all yarn scripts move to the top level?

**They mostly already are — keep that, but make the root the *only* place a
developer ever needs to type a command, and make the pattern uniform.**

The current root `package.json` got the convention right (`<task>` fans out,
`<task>:<module>` scopes down). Keep it, with three fixes:

1. **Workspaces replace `--cwd` plumbing.** `yarn --cwd webapp dev` becomes
   `yarn workspace @overlord/webapp dev`; fan-out scripts use
   `yarn workspaces foreach -A --topological run <task>`. This also fixes the class
   of bug where a sub-install is forgotten (`install:all` skipping `cli/` today).
2. **Per-package scripts stay, but stay thin.** Each module keeps `build`,
   `typecheck`, `test`, `dev` (where meaningful) so it can be worked on in
   isolation and so conformance tooling can target one module. The rule: a
   per-package script must never be the *only* way to do something — the root
   always has a delegating entry.
3. **One TypeScript runner.** Today scripts mix `tsx` (root tests, webapp) and
   `node --experimental-strip-types` (root scripts, CLI tests). Pick one — `tsx` is
   already a root devDependency and has no experimental-flag churn — and use it
   everywhere. (If the goal is zero-dep CLI tests, pick `--experimental-strip-types`
   everywhere instead; the point is consistency, not the winner.)

Resulting root surface (target state):

```
yarn setup          # one-shot bootstrap: install + build + local DB + codegen
yarn dev            # webapp server + vite (current behavior)
yarn build          # topological build of all workspaces
yarn test           # all workspaces
yarn test:cli       # one workspace        (pattern: <task>:<module>)
yarn typecheck      # all workspaces
yarn lint / fix     # repo-wide eslint (already root-level — keep)
yarn check          # lint + typecheck + test  (the "am I done?" command)
yarn db:*           # database lifecycle (below)
yarn clean / stop   # current behavior
```

## Question 3 — What other scripts would help?

Ordered by expected payoff:

1. **`yarn setup`** — the missing first-run command:
   `yarn install && yarn build && yarn db:start && yarn generate`. Today a new
   developer must discover `install:all` (incomplete), then `build`, then
   `start:local`, then `generate`, in that order, from the README and script
   spelunking. One command, idempotent, documented in the README's first code block.
2. **`yarn check`** — `lint + typecheck + test` in one command. This is what an
   agent or developer runs before delivering/committing; today it takes three
   commands and nobody runs all three.
3. **`yarn db:*` namespace** — the database lifecycle is currently scattered across
   `start:local`, `clean:local`, `generate`, and (per 1:1485) a missing migration
   story. Consolidate:
   - `db:start` (today's `start:local`), `db:reset` (today's `clean:local` + restart),
   - `db:migrate` — apply pending migrations to the local DB *without* the full
     launch path, with a `--dry-run` that lists pending files (this would have made
     the 1:1485 staleness visible immediately),
   - `db:codegen` (today's `generate`, renamed into the namespace; keep `generate`
     as an alias),
   - `db:studio` — launch the SQL Studio integration that `overlord.toml` already
     supports, so inspecting the local DB doesn't require remembering the config keys.
4. **`yarn doctor`** — a repo-level preflight that wraps/extends `ovld doctor`:
   Node version ≥ 20, Yarn version matches `packageManager`, native
   `better-sqlite3` binary loads **on this platform** (this repo syncs across
   macOS/Linux via Syncthing, where a node_modules built on one OS breaks on the
   other — a one-line check turns a confusing runtime crash into an instruction to
   re-run `yarn install`), local DB present, migrations up to date.
5. **`yarn contract:check`** — run the conformance-manifest validation
   (`ovld contract check` or the interim script) across all modules. The contract
   is the repo's spine; it should be one command to verify, and that command should
   join `yarn check` once it is fast enough.
6. **`yarn cli:link`** — build the CLI and `npm link`/`yarn link` it so `ovld`
   on the developer's PATH points at the working tree. Today testing a CLI change
   end-to-end requires knowing the `pack:cli` + global-install dance.
7. **`yarn test:watch`** — `tsx --test --watch` for the root suite (and per-module
   variants). Cheap to add, large quality-of-life gain during TDD.

## Migration plan (incremental, each phase ships alone)

**Phase 0 — quick wins, no structural change (≈ an hour)**
Fix `install:all` to include `cli/`; add `setup`, `check`, `test:watch`; unify the
TS runner; rename DB scripts into the `db:` namespace (keeping old names as
aliases).

**Phase 1 — workspaces (≈ half a day)**
Add `workspaces` to root `package.json`; delete `cli/yarn.lock`,
`webapp/yarn.lock`, per-package `.yarnrc.yml` (merging `supportedArchitectures`
into the root one); align `typescript`/`tsx`/`@types/node` versions; convert root
fan-out scripts to `yarn workspace(s)` form. Verify `pack:cli` still produces a
working tarball. **Risk note:** the per-platform native-module rebuild
(Syncthing-synced trees) must be re-verified after the lockfile merge.

**Phase 2 — `@overlord/database` package (≈ a day, per 1:1485)**
Give `/database` a `package.json`; move `src/database/*` runtime into it; CLI and
webapp depend on `workspace:*`; delete `stage-migrations.mjs` and `cli/database/`;
add `resolveAdapter()` and route `auth/src/auth/config.ts` through it. Until this lands,
apply the 1:1485 stopgap: gitignore `cli/database/`.

**Phase 3 — opportunistic module promotion (ongoing)**
Promote further modules to packages only when something needs to consume them
independently. Update the README module table with a "code lives in" column either
way.

## Contract impact

Per the repo rule (CLAUDE.md): this proposal **requires no contract version bump**.
`CONTRACT.md` defines interaction surfaces, ownership, and vocabularies — none
change. Specifics:

- Workspace conversion keeps every directory (and therefore every reference-spec
  path like `database/docs/09-database-schema-contract.md`) in place.
- The `@overlord/database` package keeps `/database` as its root, so the Database
  Layer's stable identifier and spec path are unchanged; only the *mechanism* by
  which the CLI obtains migrations changes (package resolution instead of a copy
  script), which the contract does not specify.
- If Phase 2 adds `resolveAdapter()` as the single adapter-selection point, the
  Auth → Database "Identity Bridge" surface wording ("Better Auth's configured
  database adapter") already accommodates it; a clarifying sentence there would be
  nice-to-have, not a version bump.
