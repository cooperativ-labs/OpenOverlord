# Proposal: Repo Structure & Documentation Reorganization

Status: **proposal — no code/structure changed**
Mission: coo:24
Related: [`developer-ergonomics-proposal.md`](./developer-ergonomics-proposal.md) (Phases 0–2 delivered),
[`CONTRACT.md`](../../CONTRACT.md), [`README.md`](../../README.md)

This proposal answers two questions from the mission objective:

1. Should the modules move into an `apps/` folder?
2. How can the documentation be reorganized for clarity and developer ease of use?

The short version: **the docs reorganization is the high-ROI work and should happen
first; the `apps/` move is optional polish with a real, contract-wide cost and, if
done at all, should be `apps/` + `packages/` (not a flat `apps/`) as one deliberate
phase.**

---

## 1. Current state

### 1.1 Top-level layout (16 visible directories)

```
ai/            automations/   cli/        connectors/   contract/   database/
desktop/       docs/          mcp/        planning/     scripts/    security-audits/
src/           test/          webapp/     (+ auth/)
```

Plus root files: `README.md`, `CONTRACT.md` (~118 KB), `TEST_PLAN.md`, `AGENTS.md`,
`CLAUDE.md`, `LICENSE`, config (`package.json`, `tsconfig*.json`, `eslint.config.mjs`,
`overlord.toml*`, `.env*`).

These directories are **not all the same kind of thing**, which is the root cause of
the disorientation:

| Kind | Directories | Notes |
| --- | --- | --- |
| **Yarn workspace (has `package.json`)** | `auth`, `automations`, `database`, `cli`, `webapp`, `desktop` | The six declared in root `workspaces` |
| **Root workspace source** | `src/` (service + repository + types), `test/` | The protocol/service **core**; compiled by `tsconfig.build.json`, consumed by webapp & CLI |
| **Spec / asset trees (not workspaces)** | `contract/` (YAML spec), `connectors/` (Markdown core + plugin adapters), `mcp/` (reserved placeholder) | No build output of their own |
| **Doc-like trees** | `docs/` (user guides), `planning/` (feature plans), `security-audits/`, `ai/history/` | Four separate documentation homes |
| **Tooling** | `scripts/` | Root build/dev scripts |

The single most disorienting fact (already named in the ergonomics proposal): a
newcomer reads "each module owns its code" and opens `auth/` or `automations/` —
but the *core* service code lives in root `src/service/`, not in a module folder.
Module **identity** is at the root; much module **implementation** is in `src/`.

### 1.2 Documentation inventory

There are **seven distinct documentation surfaces**, with no single map tying them
together:

1. **Root narrative docs** — `README.md` (table of contents for the whole repo),
   `CONTRACT.md` (normative spec), `TEST_PLAN.md`, `AGENTS.md`, `CLAUDE.md`.
2. **User guides** — `docs/`: `getting-started.md`, `custom-instance-setup.md`,
   `downstream-fork-agent-setup.md`, `upstream-adoption.md`.
3. **Module behavior specs** — `<module>/docs/`: each workspace has a `docs/` folder
   holding a slice of a **global numbered architecture series** plus a `testing.md`.
4. **A clean self-contained UI series** — `webapp/docs/ui/00…10` (well-ordered,
   colocated, internally consistent — the model the rest should follow).
5. **Planning** — `planning/feature-plans/` (15+ proposals, incl. a `branching/`
   subfolder).
6. **Security audits** — `security-audits/` (dated reports).
7. **Agent history** — `ai/history/` (per-mission investigation notes).

### 1.3 The two concrete documentation defects

**A. The global numbered architecture series is fragmented and inconsistent.**
The `NN-title.md` series is meant to be read in order as the architecture narrative,
but it is physically scattered across five modules with collisions and gaps:

| # | File | Module |
| --- | --- | --- |
| 01 | core-domain-and-lifecycle | cli |
| 01 | automations-overview | automations ← **duplicate 01** |
| 02 | cli-first-product-surface | cli |
| 03 | agent-protocol | cli |
| 04 | runner-and-launch-execution | cli |
| 05 | review-artifacts-and-change-tracking | cli |
| 05 | connectors-and-agent-plugins | connectors ← **duplicate 05** |
| 06 | — | **missing** |
| 07 | user-token-authentication | auth |
| 08 | role-based-access-control | auth |
| 09 | database-schema-contract (+ -review) | database |
| 10 | database-table-groups | database |
| 11 | — | **missing** |
| 12 | private-network-postgresql-deployment-plan | database |
| 13 | database-seeding-framework | database |

A reader cannot follow the series sequentially without already knowing which module
each number lives in, and the numbering no longer means anything (duplicates 01/05,
gaps 06/11). The README links each module's README but never presents this series as
the ordered whole it was designed to be.

**B. The README advertises a planning index that does not exist.**
`README.md` states: "*[planning/feature-plans/](planning/feature-plans/README.md) is
now a redirect index pointing at those module homes.*" There is **no
`planning/feature-plans/README.md`** — the link is broken. (Verified: file absent.)

### 1.4 How tightly is the current layout pinned?

`CONTRACT.md` and the contract YAML pin module locations as **reference-spec paths**
and code paths — roughly **23 path references in `CONTRACT.md`** alone (e.g.
`database/docs/09-database-schema-contract.md`, `cli/src/branch-preparation.ts`,
`auth/docs/08-…`), plus `contract/components.yaml`, conformance manifests, root
`package.json` `workspaces`, `tsconfig*.json` `include`, `cli/tsconfig.build.json`
`rootDir` reaches, and many README/inter-doc links. **Any directory move rewrites all
of these.** This is exactly why the ergonomics proposal deliberately kept every
directory in place ("Workspace conversion keeps every directory… in place").

---

## 2. The `apps/` question

### 2.1 A flat `apps/<everything>` is the wrong shape

The standard monorepo convention distinguishes **deployable applications** from
**shared libraries**:

- `apps/` → things you run/ship: `webapp`, `desktop`, the publishable `cli`.
- `packages/` → things other workspaces import: `database`, `auth`, `automations`,
  and the root `src/` core.

Dropping `database`/`auth`/`automations` into `apps/` would mislabel libraries as
applications and make the layout *less* legible, not more. So if we consolidate at
all, the target is:

```
apps/
  cli/        # publishable open-overlord
  webapp/     # web control center + REST/realtime API
  desktop/    # optional Electron shell
packages/
  core/       # ← today's root src/ (service, repository, types) — the protocol core
  database/
  auth/
  automations/
contract/     # the spec spine — stays at root (it is not a workspace; it governs all)
connectors/   # core + plugin adapters — assets, not a workspace — stays at root
mcp/          # reserved placeholder — stays at root until implemented
docs/  planning/  security-audits/  scripts/  test/
```

The biggest legibility win in that sketch is **`src/` → `packages/core/`**: it gives
the protocol/service core a *named module identity* and ends the "modules are folders
but the core is in `src/`" confusion. That single rename arguably delivers more
clarity than relocating the six already-obvious workspaces.

### 2.2 The cost is real and contract-wide

Per `CLAUDE.md`, a change that a module cannot satisfy against the contract requires a
**contract change plus an impact list across all modules**. Moving directories does
exactly that — it invalidates the ~23 pinned spec/code paths above. Concretely the
move touches, at minimum:

- `CONTRACT.md` reference-spec and code-path lines (~23) and `contract/components.yaml`.
- Root `package.json` `workspaces` globs; every workspace's internal relative imports
  that cross into `src/` (webapp `server/*`, `cli` build `rootDir`).
- `tsconfig.json` / `tsconfig.build.json` `include`/`rootDir`; `eslint.config.mjs`;
  `scripts/*` that reference `database/…`, `src/…`.
- README module table + every inter-doc link; conformance manifests.
- Git history/blame continuity for the moved trees.

None of this is hard individually; collectively it is a **wide, mechanical, high-
churn change** whose only payoff is a tidier root listing. That is a weak trade unless
it is bundled with a decision the team actually wants (e.g. promoting `core`).

### 2.3 Recommendation on `apps/`

1. **Do not** do a flat `apps/<everything>` move.
2. **Defer** the `apps/` + `packages/` split as a *standalone, opt-in* structural
   phase. It should only happen when the team decides the root-clutter cost outweighs
   the contract-path churn — and when it does, treat the **contract path vocabulary**
   as the first artifact to update (see §4, Phase S).
3. **If** any piece of it is done sooner, do the **`src/` → `packages/core/`**
   promotion alone: it removes the single worst point of confusion, is the natural
   continuation of the ergonomics proposal's "converge module folders as packages"
   path, and can be scoped without moving the already-clear workspaces.

---

## 3. Documentation reorganization (the high-ROI work)

These changes need **no directory moves** and **no contract bump** — they make the
existing docs navigable. Ordered by payoff:

### D1. Add a single docs map: `docs/README.md`

One page that is the front door to *all seven* doc surfaces — user guides, the
architecture series (in reading order, linking wherever each file physically lives),
module READMEs, planning, testing, security audits. The root `README.md` links to it
once ("**Documentation map →** `docs/README.md`"). This restores a table of contents
without moving a single file.

### D2. Restore the global architecture series as an ordered index

Two viable approaches; **recommend B**:

- **A — Re-home + renumber.** Move every `NN-*.md` into `docs/architecture/`,
  renumber cleanly (no gaps/dupes). *Pro:* one folder, truly sequential. *Con:*
  breaks colocation-with-owning-module (a core repo principle) and rewrites ~10
  contract reference-spec paths → contract bump.
- **B — Keep colocated, add an ordered index (recommended).** Leave each `NN-*.md`
  in its module `docs/` (preserves colocation and all contract paths), and add a
  **`docs/architecture.md` index** that lists the series in intended reading order
  with links. Separately, **fix the numbering defects** in place: resolve the two
  duplicate `01`/`05` numbers and the `06`/`11` gaps by renumbering only the
  *non-contract-pinned* files, or by switching the series to module-prefixed numbers
  (e.g. `cli-01`, `auth-07`). This gets sequential readability while keeping the
  contract stable. (`webapp/docs/ui/00…10` is the proof this works — copy its
  discipline.)

### D3. Create the missing `planning/feature-plans/README.md`

The README already promises it. Make it the redirect index it claims to be: a short
table mapping each planning doc to its owning module / topic, with the `branching/`
subfolder grouped. Fixes the broken link and gives `planning/` a front door.

### D4. Write down the documentation taxonomy

Add a short "Where docs live" section (in `docs/README.md` and/or the README "For
Developers" area) stating the rule for each surface, so future docs land in the right
place by default:

| Surface | Holds | Lives in |
| --- | --- | --- |
| User guides | install/setup/operate Overlord | `docs/` |
| Architecture series | how the system works, in order | `<module>/docs/NN-*.md` (indexed by `docs/architecture.md`) |
| Module behavior specs | per-module detail + `testing.md` | `<module>/docs/` |
| Planning / proposals | not-yet-built or under-discussion work | `planning/feature-plans/` |
| Security audits | dated external-surface reviews | `security-audits/` |
| Agent history | per-mission investigation notes | `ai/history/` |
| Normative spec | the contract | `CONTRACT.md` + `contract/` |

### D5. (Optional) Tidy root markdown discoverability

`AGENTS.md` / `CLAUDE.md` are agent-facing; `README.md` / `CONTRACT.md` /
`TEST_PLAN.md` are human-facing. No move needed — just ensure `docs/README.md` and the
README's intro name each so newcomers know which file answers which question.

---

## 4. Suggested sequencing

Each phase ships independently; docs first because it is pure upside.

- **Phase D (docs, ~half a day, no contract impact):** D1 `docs/README.md` map →
  D3 missing planning index (fixes a live broken link) → D2-B architecture index +
  numbering fix → D4 taxonomy section. Update the README's two references (the docs-map
  link; correct/keep the planning-index link).
- **Phase C (core promotion, optional, ~1 day):** `src/` → `packages/core/` only,
  per §2.3.3, with the contract path updates it entails. Standalone, reversible-ish,
  high clarity-per-line.
- **Phase S (full `apps/` + `packages/` split, opt-in, only on team decision):**
  Treat the contract path vocabulary as the first artifact. Move workspaces under
  `apps/`/`packages/`, update `workspaces` globs, tsconfig `include`/`rootDir`,
  scripts, conformance manifests, all inter-doc links, and the ~23 `CONTRACT.md`
  paths in one reviewed change. Re-verify `yarn build:prod`, `yarn cli:pack:prod`, and
  the per-platform native rebuild afterward.

## 5. Contract impact

- **Phase D:** none — adding index/map files and (D2-B) renumbering only the files
  *not* referenced by `CONTRACT.md`. If any renumber touches a contract-pinned path,
  it is promoted into Phase C/S instead.
- **Phase C:** updates the Database/Auth/service reference-spec and code paths that
  point into `src/`; a path-only change, no vocabulary or surface change → patch-level
  contract note, not a behavioral version bump.
- **Phase S:** a repo-wide reference-spec path rewrite. No interaction surface,
  ownership, or vocabulary changes, so semantically a documentation-path bump — but it
  must be landed atomically with the directory move so the contract never points at a
  stale path.

## 6. Recommendation

1. **Do Phase D now** — it is the actual "clarity and ease of use" win the mission
   asks for, costs nothing in contract churn, and fixes a live broken link.
2. **Hold the `apps/` move** as opt-in. If structure is to change, the
   `src/ → packages/core/` promotion (Phase C) buys the most clarity per unit of
   churn; a flat `apps/<everything>` is not recommended at all.
3. Whenever directories do move, update the **contract path vocabulary first** and
   land the move atomically.
