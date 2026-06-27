# Investigation: Delivery blocked by unrelated worktree changes

Mission: `ove:12` — Investigate Delivery Block.

## Symptom

> "Delivery is blocked in Overlord because unrelated changes to `webapp/package.json`
> and likely `webapp/server/objectives.test.ts` appeared during the session and the
> protocol requires rationales for them. I posted a blocking Overlord question rather
> than misattribute those files."

Agents working in the shared cross-platform tree (one checkout mounted into both the
macOS host and the Linux Agent-Pod via OrbStack) are forced to write change rationales
for files some *other* process touched, and so cannot deliver without either lying about
authorship or blocking.

## The design is already correct — it just silently degrades

The intended behaviour is exactly what we want: **report all files the agent changed,
and deliberately drop git changes the agent was not responsible for.** That logic lives
in `cli/src/vcs.ts`:

1. **Baseline at attach.** `writeBaseline()` snapshots every currently-dirty path
   (`path`, status, and a `git hash-object` content hash) into
   `~/.ovld/vcs-baselines/<key>.json`, where `<key> = sha256(abspath(cwd) + "\0" + MISSION_ID)`.
2. **Run delta at deliver.** `computeRunDelta()` = current `git status --porcelain`
   minus the baseline (a path is run-attributable when it is new, or its content hash
   differs from the baseline hash).
3. **Intersection with the agent's own edits.** `filterRunAttributableChanges()` then
   intersects that delta with a per-session **touched-files log** —
   `~/.ovld/vcs-touched/<same-key>.json` — listing the exact files this agent edited.
   When that log is present, *"files this agent never touched are never reported, even if
   they are dirty for unrelated reasons."* This intersection is the precise mechanism that
   is supposed to drop the concurrent `webapp/package.json` / `objectives.test.ts` edits.
4. `.overlordignore` and `--no-file-changes` are the remaining escape hatches.

Server-side, `packages/core/service/protocol.ts` (`recordDelivery`) aggregates the
objective's `changed_files` rows where `current_diff_state === 'present'` (excluding
`package-lock`) and throws `missing_rationale` (HTTP 400) for any without a rationale.
So whatever the CLI reports as changed becomes a hard rationale requirement.

## Root cause: the touched-files log is never written in Agent-Pod runs

The touched-files log is written by the Claude **PostToolUse** hook,
`connectors/adapters/claude/scripts/post-tool-use-hook.sh`. Its very first guard is:

```sh
if [ -z "${MISSION_ID:-}" ]; then
  log_hook "no MISSION_ID in env; skipping"
  exit 0
fi
```

**`MISSION_ID` is never present in the Agent-Pod environment.** Verified live during this
mission:

- `env | grep MISSION_ID` → nothing. The pod env has `AGENT_POD_OVERLORD=1`,
  `OVERLORD_BACKEND_URL`, `OVERLORD_USER_TOKEN`, but **no** `MISSION_ID` /
  `OVERLORD_MISSION_ID` / `OVERLORD_EXECUTION_REQUEST_ID`.
- `~/.ovld/logs/post-tool-use-hook.log` is wall-to-wall `no MISSION_ID in env; skipping`.
- For this session's key, `~/.ovld/vcs-baselines/<key>.json` exists (35 files captured at
  attach) but `~/.ovld/vcs-touched/<key>.json` does **not** — and never will.

With no touched log, `readTouchedPaths()` returns `null`, the intersection in
`filterRunAttributableChanges()` is **disabled by design** (so hookless connectors keep
working), and attribution falls back to baseline-only. Any file that becomes dirty *after*
attach — e.g. `webapp/package.json` edited by a concurrent host-side process on the shared
mount — has no baseline entry, passes the `!base` run-attributable check, and is reported
as this agent's change. The server then demands a rationale for it → delivery blocks.

### Why `MISSION_ID` is missing

`cli/src/launch.ts` *does* build the right environment — `overlordLaunchEnv()` sets
`MISSION_ID`, `OVERLORD_MISSION_ID`, `OVERLORD_BACKEND_URL`, `OVERLORD_EXECUTION_REQUEST_ID`
— and the terminal launcher exports them (`cli/test/launch.test.ts` and
`cli/test/terminal-launcher.test.ts` assert `export MISSION_ID='coo:11'`). But the
Agent-Pod launch path does **not** go through `overlordLaunchEnv`. The pod launcher that
sets `AGENT_POD_OVERLORD=1` is host-side and lives **outside this repo** (no `AGENT_POD`
reference exists anywhere in OpenOverlord). It propagates the backend URL and user token
into the pod but not the mission id, so the hook can never identify its session.

## Why the agent has no clean CLI workaround today

In `applySessionChangedFiles()` (`cli/src/commands.ts`), for `deliver` the explicit
`--changed-files-json` is **unioned** with the computed delta, then attribution-filtered:

```ts
const merged = subcommand === 'deliver' ? [...explicit, ...delta] (dedup) : explicit;
const attributable = filterRunAttributableChanges({ ... files: merged });
```

An explicit list can therefore only **add** files, never **remove** one the delta already
contains. So when the intersection is disabled, the agent cannot narrow the reported set
below the over-attributing delta from the CLI side. The only real levers are:

- `.overlordignore` (per-pattern; clumsy for ad-hoc concurrent files),
- `--no-file-changes` (all-or-nothing; wrong when the agent *did* change files),
- manually writing the touched-files log so the intersection re-activates (the current
  field workaround — call the exported `recordTouchedFiles()` before delivering).

## Recommended fixes (ranked)

1. **Decouple the touched-files hook from `MISSION_ID` (best, fully in-repo).**
   At `attach`/`resume-follow-up`, have the CLI also write a **cwd-keyed** active-mission
   pointer, e.g. `~/.ovld/vcs-active-mission/<sha256(abspath(cwd))>.json = { missionId }`.
   The PostToolUse hook already knows `cwd` (from the tool body) — it can resolve the
   mission from that pointer when `MISSION_ID` is absent, then write the touched log under
   the existing `(cwd, missionId)` key. This makes attribution robust regardless of whether
   the launcher remembered to export `MISSION_ID`. (One pointer per cwd assumes one active
   mission per checkout, which holds for the per-pod case; keep the env var as the
   disambiguator when several missions share a cwd on the host.)

2. **Inject `MISSION_ID` in the Agent-Pod launcher (host-side).** Mirror
   `overlordLaunchEnv()` so the pod exports `MISSION_ID`/`OVERLORD_MISSION_ID` like the
   terminal launcher does. Correct, but lives outside this repo and only covers the pod
   path; (1) is more defensive.

3. **Let the agent authoritatively scope deliver.** Add a `--only-changed-files` (or make
   `--changed-files-json` intersect rather than union at deliver) so an agent that knows
   exactly what it changed can cap the reported set. Useful belt-and-suspenders even with
   (1)/(2) in place.

4. **Surface the silent degradation.** When `deliver` computes a delta with **no** touched
   log present, emit a warning (and/or a hook self-check at attach) so "intersection
   disabled → baseline-only" is visible instead of silently over-reporting.

## Verification notes

- `cli/src/vcs.ts` — baseline, run-delta, touched-files intersection, `.overlordignore`.
- `cli/src/commands.ts` — `applySessionChangedFiles` union-then-filter; `--no-file-changes`.
- `packages/core/service/protocol.ts` — `recordDelivery` `missing_rationale` enforcement.
- `connectors/adapters/claude/scripts/post-tool-use-hook.sh` — `MISSION_ID` guard.
- `cli/src/launch.ts` — `overlordLaunchEnv` (terminal path sets `MISSION_ID`; pod path does not).
- Live evidence: hook log + missing `vcs-touched/<key>.json` + present `vcs-baselines/<key>.json`.
