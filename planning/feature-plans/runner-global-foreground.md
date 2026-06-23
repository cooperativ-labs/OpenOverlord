# Global Foreground Runner — one terminal, all accessible projects

**Status:** Proposal (planning only — no code in this mission)
**Mission:** coo:4 — *Automate job launch on run button click*
**Objective:** *Exclude `--detach`; keep the runner in an open terminal window, but run it
globally and serve all projects the user has access to. How does that change the plan?*
**Supersedes (for this direction):** [`runner-background-daemon.md`](runner-background-daemon.md) — see §2 for the diff
**Contract baseline:** `0.5-draft`
**Layer:** Runner Layer (`runner`); future access-scoping touches Auth Layer (`auth`)
**Reference spec:** [`cli/docs/04-runner-and-launch-execution.md`](../../cli/docs/04-runner-and-launch-execution.md)

---

## 1. TL;DR

The new constraints **shrink** the plan rather than grow it, because the runner is
**already global by default** at the data layer:

1. **No `--detach`, no service.** We keep `ovld runner start` as a foreground
   process in one terminal window. Everything in the prior plan about detaching
   the poller — PID files, `runner stop`, launchd/systemd `install-service`,
   `[runner].autostart` — is **dropped** (or deferred), not built.

2. **"Global, all accessible projects" is mostly the status quo.** There is one
   workspace and one SQLite DB per Overlord instance. `claimNextExecutionRequest`
   already scans `execution_requests` for the **whole workspace** and treats
   `--project-id` only as an *optional restriction*
   (`src/service/execution-requests.ts:326-347`; the spec literally says
   "`--project-id <id>` to **restrict** claims",
   `cli/docs/04-runner-and-launch-execution.md:46`). Working directory is resolved
   **per request, per project** (`resolveWorkingDirectory`,
   `execution-requests.ts:118-148`), and each agent already opens in its own
   window via `terminal_launcher`. So a single `ovld runner start` with **no**
   `--project-id` already serves every project in the workspace.

3. **The work therefore moves from "background the poller" to "make the one
   foreground poller safe and correct across many projects."** Two live gaps
   (A, C) plus one that the global DB move has now largely closed (B):
   - **(A) Loop error isolation — critical.** The poll loop is
     `while (true) { await runOnce(); sleep }` with **no try/catch**
     (`cli/src/commands.ts:850-853`), and `runOnce` *re-throws* on a missing
     working directory or a failed launch (`commands.ts:816,827-833`). Per-project
     today that kills one project's poller; **globally it kills the poller for
     every project.** A global runner must not let one bad project take down the
     others.
   - **(B) Instance-stable DB resolution — now structurally solved.** The DB has
     moved to a per-user **global** location: `resolveDatabasePath` defaults to
     `~/.ovld/Overlord.sqlite` (`cli/src/config.ts:214-232`,
     `database/src/local-paths.ts:39-41`), with `overlord.toml` `database_path`
     and `OVERLORD_SQLITE_PATH` as explicit overrides. A global runner started
     from anywhere now binds to the same instance DB by default — no cwd-relative
     empty-DB trap. The only residual is observability: the runner should print
     which DB (and which source) it resolved. See §5.B.
   - **(C) Multi-project working-dir readiness.** Each project must have a
     primary resource registered on this device (`ovld add-cwd`), or its claim
     throws at launch time. With many projects this needs a pre-flight so the
     operator sees gaps before a run fails.

4. **"Access" needs a definition as multi-user lands.** Today the runner claims
   the entire workspace and RBAC is *instance-level*
   (`role_assignments` use empty-string sentinels for instance scope;
   per-project membership is explicitly *future* —
   `auth/docs/08-role-based-access-control.md:109`,
   `database/docs/09-database-schema-contract.md:108`). So "projects the user has
   access to" == "all projects in the workspace" **today**. Real per-project
   access-scoping is a future filter that belongs to the Auth permission-check
   interface (§6, §7).

5. **Contract impact is even smaller than the prior plan** — still additive, no
   version bump (§7).

---

## 2. What changes vs. the `--detach` plan

| Prior plan item | Fate under "foreground + global" |
| --- | --- |
| `ovld runner start --detach` self-fork | **Dropped.** We keep the foreground terminal on purpose. |
| PID files under `~/.ovld/runner/`, single-instance guard | **Dropped** (no daemon). A lightweight single-instance guard is still *nice* but optional (§5.D). |
| `ovld runner stop` | **Dropped.** Ctrl-C in the window stops it. |
| `ovld runner logs [--follow]` | **Dropped.** Output is right there in the foreground window; just improve what it prints (§5.E). |
| Phase 2 `install-service` (launchd/systemd), `[runner].autostart` | **Deferred** — stays "Future behavior" in the spec; not part of this direction. |
| Keep the launched-agent window via `terminal_launcher` | **Unchanged** — same as before. |
| Alternative D (webapp spawns `runner once`) | **Still rejected** for the same reason (couples Runner launch to the REST lifecycle). |
| **New focus:** loop hardening, multi-project readiness, access definition | **Added** — this is where the work goes now. |
| Instance-stable DB resolution | **Largely solved** — the DB moved to a per-user global location (`~/.ovld/Overlord.sqlite`), so a runner started anywhere binds to the same instance by default; only a resolution banner remains (§5.B). |

Net: the prior plan's value was *moving the poller off-screen*. We are no longer
doing that, so most of it falls away. What's left — and newly important — is
making the one always-visible poller robust enough to babysit **N** projects at
once.

---

## 3. Why "global" is (almost) free here

```
ovld runner start                 # already: claim across ALL projects in the workspace
ovld runner start --project-id X  # opt-in restriction to one project
```

- **One workspace, one DB — now at a global location.** `createServiceContext`
  selects the single oldest workspace (`src/service/context.ts:29-42`); the DB
  holds every project as a row. That DB now lives at a per-user global path
  (`~/.ovld/Overlord.sqlite` by default), so any working directory resolves to the
  same instance (§5.B).
- **Claim is workspace-scoped, project-optional.** `claimNextExecutionRequest`
  filters on `workspace_id` + `status='queued'` and only adds `project_id` when
  the flag is present (`execution-requests.ts:336-347`).
- **Per-project routing is already correct.** Each request stores its own
  `resolved_working_directory` at enqueue (`execution-requests.ts:218-222,248`),
  re-resolved on claim (`:364-368`), and `launchAgent` opens that directory in a
  fresh window (`commands.ts:793-809`). Two projects → two correctly-rooted
  windows, from one poller.

So the headline behavior the objective asks for already exists. The plan is about
turning "happens to work if you omit `--project-id`" into "a deliberate,
hardened, documented global mode."

---

## 4. The real risk this direction introduces: blast radius

A per-project runner fails small. A **global** runner concentrates risk: it is the
single process responsible for launching *every* project's work, and today it is
fragile.

```ts
// cli/src/commands.ts:850-853  (current)
while (true) {
  await runOnce();                 // throws on missing dir / nonzero launch status
  await new Promise(r => setTimeout(r, intervalMs));
}
```

`runOnce` throws when `resolveWorkingDirectory` can't find a usable dir
(`execution-requests.ts:144`) or when the launch command exits nonzero
(`commands.ts:810-816`), and it re-throws inside the `catch` after marking the
request failed (`commands.ts:827-833`). An unhandled throw here **ends the
`while` loop**, so:

> One project with an unregistered/missing working directory, or one agent binary
> that exits nonzero, silently stops auto-launch for **all** projects until
> someone notices the dead terminal.

This is the single most important change for the global direction.

---

## 5. Proposed changes

### 5.A — Per-iteration error isolation (required)

Wrap each `runOnce()` so a single failed claim/launch is logged and the loop
continues. The request is already marked `failed` with its error
(`markExecutionFailed`), so the queue stays consistent; we just must not let the
exception escape the loop.

```ts
while (true) {
  try {
    await runOnce();
  } catch (error) {
    // already recorded on the request via markExecutionFailed; keep polling
    console.error(`[runner] launch error (continuing): ${msg(error)}`);
  }
  await sleep(intervalMs);
}
```

Keep `ovld runner once` strict (it should still surface the error to its caller);
only the long-running `start` loop swallows-and-continues.

### 5.B — Instance-stable resolution (now solved by the global DB location)

**Update (2026-06-15): the DB has moved to a global location, which resolves this
gap structurally.** `resolveDatabasePath` (`cli/src/config.ts:214-232`) now picks
the database in this precedence:

1. `OVERLORD_SQLITE_PATH` env var (tilde-expanded; relative resolves against the
   project root) — `config.ts:215-221`.
2. `overlord.toml` `database_path` override (tilde-expanded; relative resolves
   against the `overlord.toml` directory) — `config.ts:228-231`.
3. **Default: the per-user global file `~/.ovld/Overlord.sqlite`**
   (`resolveGlobalDatabasePath`, `database/src/local-paths.ts:39-41`; the
   directory is relocatable via `OVLD_HOME`, `local-paths.ts:27-31`).

The old behavior — walk up from `cwd` for `overlord.toml` and fall back to a
**repo-relative** `database/.local/Overlord.sqlite` — was the source of the
foot-gun: a runner started in an unrelated tree opened a *different, empty* DB and
claimed nothing. That fallback is gone. **By default, `ovld runner start` from any
directory now binds to the same single global instance DB** — exactly the
"instance-stable" property a global runner needs, with zero new flags or pointer
files.

What remains is a smaller, deliberate case rather than an accidental one:

- **The `overlord.toml` override still walks up from `cwd`.** If you start the
  global runner *inside a project tree whose `overlord.toml` sets `database_path`*
  (or that project exports `OVERLORD_SQLITE_PATH`), the runner binds to that
  project's override instead of the global default. This is now an explicit,
  opt-in redirect — useful for running a runner against a non-default instance —
  not a silent empty-DB trap.
- **Mitigation is observability, not a new resolver.** The startup banner (§5.E)
  must print the **resolved DB path** and whether it came from the global default,
  an `overlord.toml` override, or `OVERLORD_SQLITE_PATH`, so the operator can
  confirm the runner is bound to the intended instance. The simplest safe default
  for "global, all projects" is to start the runner from a directory with **no**
  `database_path` override (e.g. the user's home), letting it resolve the global
  DB.

**No `--global` flag or `~/.ovld/instance.json` pointer is needed.** The global
default DB *is* the stable instance pointer. (`~/.ovld` is now the home for that
DB, so a future explicit instance pointer, if ever wanted, would live alongside
it — but it is not required for this direction.)

### 5.C — Multi-project working-directory pre-flight

Because a missing primary resource throws at claim time
(`execution-requests.ts:138-147`), `ovld runner status` should **pre-flight all
projects** and report which are launch-ready vs. which need `ovld add-cwd` on this
device — grouped by project, e.g.:

```
Device: Jakes-MBP (a1b2…)   Mode: global (all projects)
Project Overlord      ✓ /Users/jake/Development/Cooperativ/OpenOverlord   2 queued
Project Acme          ✗ no resource on this device — run `ovld add-cwd`    1 queued
```

`listExecutionRequests` already returns the whole workspace when `projectId` is
omitted (`execution-requests.ts:289-309`); this is a reporting/grouping addition
plus a resource-existence check per project.

### 5.D — Optional single-instance guard (nice-to-have)

Two concurrent global pollers are *correctness-safe* (claim is an atomic
compare-and-set, `execution-requests.ts:372-383`) but waste cycles and can double
up. A minimal advisory lock (e.g. a `~/.ovld/runner/global.lock` with a liveness
check) can warn "a global runner already appears to be running." Lower priority
than 5.A–5.C; carry the device-fingerprint keying idea from the prior plan if we
do it.

### 5.E — Foreground observability

Since the window stays open, make it worth watching: include the **project name**
in the launch line (`commands.ts:822-824` currently prints only agent + mission),
and print a startup banner naming the mode ("global — all projects"), the
resolved DB path, **and its source** (global default `~/.ovld/...`, an
`overlord.toml` `database_path` override, or `OVERLORD_SQLITE_PATH`) so the
operator can confirm the runner is bound to the right instance. With the global
default DB (§5.B) this banner is the primary guard against accidentally running
against an unintended instance.

---

## 6. What "access" means — now vs. later

| | Today (single workspace, instance RBAC) | Future (per-project access) |
| --- | --- | --- |
| Operator identity | first active `workspace_user` (`context.ts:44-55`) | the authenticated user running the runner |
| Claimable scope | **all** projects in the workspace | only projects the operator can `execution_request:*` on |
| Mechanism | workspace_id filter only | add an access filter to the candidate query, sourced from the Auth permission-check interface |

The spec and RBAC docs already anticipate this: "Per-user and organization-owned
target ownership" and "Access control for managing resources" are listed as
*Future* (`cli/docs/04-runner-and-launch-execution.md:78-79`), and RBAC promises
"resource/context-aware checks, such as project membership or ownership, even if
the first implementation only uses instance-level roles"
(`auth/docs/08-role-based-access-control.md:109`).

**Recommendation:** implement the global foreground runner now against the
current "whole-workspace == all accessible projects" reality, and add a single
seam — an access predicate applied to the candidate set in
`claimNextExecutionRequest` — so that when project-level RBAC lands, "all projects
the user has access to" becomes a real filter without reworking the runner. Until
then the predicate is "everything in the workspace."

---

## 7. Contract impact

Per [`CONTRACT.md`](../../CONTRACT.md) maintenance rules, **additive, no version
bump**:

- **Runner Layer** already owns "`execution_requests` queue claiming and launch",
  "Working directory resolution", "`ovld runner` commands", and "Execution target
  selection logic" (`CONTRACT.md:111-115`). Loop hardening (5.A), the global
  default DB location + banner (5.B), status pre-flight (5.C), the optional guard
  (5.D), and richer logging (5.E) all sit **inside** that ownership — no interface
  change. The DB-location move itself is owned by the Database Layer's path
  resolution and is already implemented; the runner only consumes the resolved
  path.
- **No new closed vocabulary**, no `execution_requests.status` change, no protocol
  or schema change — none of the version-bump triggers apply.
- **Future access-scoping (§6) is the only cross-layer item.** When built, the
  claim filter must consume the **Auth Layer**'s permission-check interface
  (`CONTRACT.md` Auth Layer "Permission check interface") rather than re-deriving
  access in the Runner Layer. Note it as a Runner→Auth dependency *when that work
  is scheduled*; it is out of scope for the foreground-global runner itself.
- If a `[runner]` config table is added later (e.g. a default `global = true`),
  name its keys in the CLI registry line exactly as `terminal_launcher` is named
  — a doc update, not a version bump. Not required for this direction.

---

## 8. Acceptance criteria

- `ovld runner start` (no `--project-id`), left running in one terminal window,
  launches queued work for **every** project in the workspace, each agent in its
  own correctly-rooted window.
- A queued request for a project with a missing/unregistered working directory is
  marked `failed` **and the poller keeps serving all other projects** (no loop
  death).
- A launch command exiting nonzero for one project does **not** stop launches for
  the others.
- `ovld runner status` shows, grouped by project, which projects are launch-ready
  on this device and which need `ovld add-cwd`, plus queued counts.
- Starting the runner outside any project tree binds to the per-user **global**
  DB (`~/.ovld/Overlord.sqlite`) by default — never to an empty repo-relative DB.
  An `overlord.toml` `database_path` or `OVERLORD_SQLITE_PATH` override redirects
  it deliberately. The startup banner prints the resolved DB path, its source
  (global default / `overlord.toml` / env), and the mode.
- No background process, PID file, or OS service is introduced; closing the
  window (Ctrl-C) stops the runner.

---

## 9. Suggested follow-up objectives (if approved)

1. **Harden the loop (5.A) + foreground observability (5.E):** wrap `runOnce` in
   the `start` loop, add the project name to the launch line and a startup banner
   with mode + resolved DB path. *(Smallest, highest-value; do first.)*
2. **Banner + status pre-flight (5.B, 5.C):** instance-stable DB resolution is
   already done by the global default DB (§5.B), so the remaining work is the
   startup banner that prints the resolved DB path + source, plus project-grouped,
   launch-readiness reporting in `ovld runner status`.
3. **Docs:** promote the global foreground runner to *Supported* in
   `cli/docs/04-runner-and-launch-execution.md` and document it in the README
   (one terminal serves all projects; how `access` is scoped today vs. later).
4. **(Later, gated on RBAC)** Add the access predicate seam (§6) so claims filter
   to the operator's accessible projects via the Auth permission-check interface.
