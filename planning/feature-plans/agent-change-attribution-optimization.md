# Agent Change Attribution: Completeness-First Optimization

**Mission:** coo:127 — Optimize Agent File Change Reporting
**Status:** Recommendation (no code changes yet)
**Date:** 2026-07-03

## Problem

Agents operating concurrently on the same branch spend significant transcript time
figuring out which dirty files in `git status` are theirs before delivering. The
protocol requires every meaningful tracked change in the objective's coverage set to
carry a rationale (or an explicit skip), so agents defensively triage the whole dirty
tree, and delivery frequently bounces with `missing_rationale` for files another
mission changed.

The mission asks: could we observe the agent's tool calls to keep a running list of
every file the agent changed, then require the agent to account for only those? What
maximizes completeness (first priority) and efficiency?

## Finding 1: the proposed mechanism already exists — but is inert in practice

The tool-call-observation design is already implemented end to end:

- `connectors/adapters/claude/scripts/post-tool-use-hook.sh` — a `PostToolUse` hook
  (matcher `Edit|Write|MultiEdit|NotebookEdit`) records every file the agent edits
  into a per-session touched-files log at
  `~/.ovld/vcs-touched/<sha256(abspath(cwd) + "\0" + MISSION_ID)>.json`, plus
  lightweight rationale notes used to prefill draft rationales.
- `cli/src/vcs.ts` — `attach` records a content-hash baseline of the dirty tree;
  `deliver` computes the run delta (worktree state differing from baseline) and,
  when a touched-files log exists, **intersects** the delta with the agent's own
  edits (`filterRunAttributableChanges`). Hookless connectors fall back to
  baseline-only.
- `packages/core/service/protocol.ts` (`deliverSession`) — enforces objective-scoped
  rationale coverage over the `changed_files` rows the client reported.

**Why agents still burn time:** the hook requires `MISSION_ID` in the environment
and it is not set in agent-pod sessions. Verified live during this mission's own
session — every file edit logged:

```
2026-07-03T12:59:37Z [claude-post-tool-use] no MISSION_ID in env; skipping
```

With no touched log, `readTouchedPaths` returns `null`, the intersection is
disabled, and deliver falls back to baseline-only attribution. Under concurrency
that fallback is structurally wrong: a file another mission dirties *after* this
session attached has no baseline entry, so it is attributed to this agent. Deliver
rejects with `missing_rationale`, and the agent spends turns running `git status`,
reasoning about which changes are its own, and hand-writing `--skip-rationale-for`
entries. The observed inefficiency is not a missing feature; it is a dead activation
path for a feature that already shipped.

## Finding 2: even when active, hard intersection has a completeness hole

The touched log only sees Claude's native file-editing tools. Files changed through
`Bash` — codegen, package managers, migration runners, `git mv`, `sed`, build
scripts — never enter the log. When the log exists, the intersection **silently
drops** those paths from the delivery report. With completeness as the first
priority, a tool-call log must never be treated as exhaustive: it is reliable
*positive* evidence ("I definitely changed this") but unreliable *negative* evidence
("I didn't change that").

This directly answers the mission's core question: **yes, observe tool calls — but
use the resulting list as confirmation and as cross-session claims, not as a hard
filter, and never as the sole source of truth.**

## Finding 3: server-side over-attribution is sticky

`upsertChangedFiles` marks rows `current_diff_state = 'present'` and nothing ever
reconciles them to `'absent'`. One over-attributed `update` (e.g. posted while the
hook was inert) permanently poisons the objective's coverage set: every later
deliver for that objective re-demands a rationale for a file the agent never
touched, even after the client-side filtering is fixed.

## Recommendation

Layered, ordered by return on effort. The attribution rule that maximizes
completeness first, then efficiency:

> **Report every path whose worktree state changed since my baseline, minus paths
> positively claimed by another live session. My own touched log confirms and
> classifies; other sessions' touched logs exclude. Unclaimed ambiguous paths stay
> attributed to me (completeness) but are pre-classified so no transcript time is
> spent triaging.**

### Layer 1 — Make activation reliable (small; removes most observed waste)

- Stop depending on the `MISSION_ID` env var. At `attach`, the CLI already persists
  session resolution per working directory; additionally write a per-cwd **active
  session manifest** (e.g. `~/.ovld/vcs-sessions/<cwd-hash>.json` with
  `{missionId, sessionKey, attachedAt}` entries, pruned on deliver/expiry). The hook
  resolves the mission from the manifest using the `cwd` in the hook payload, with
  the env var kept as an override.
- Add deliver-time self-diagnosis: when a session's connector installs the edit hook
  but no touched log exists at deliver, print a loud warning (and emit telemetry) so
  regressions like the current one surface immediately instead of as agent slowness.
- Port the hook to the Codex and Cursor adapters (only Claude has one today), or
  route it through a single `ovld protocol record-touched` subcommand so adapters
  share one implementation.

### Layer 2 — Close the Bash gap (medium; required before trusting the log)

- Extend the hook matcher to include `Bash`. After each Bash call, run
  `git status --porcelain`, diff against a cached last-seen snapshot stored beside
  the touched log, and append newly changed/newly re-hashed paths. One `git status`
  per Bash call is cheap and mechanical.
- Until Layer 3 lands, soften the deliver-time intersection: a delta path missing
  from my touched log should be **flagged, not dropped** when it also has no other
  claimant — completeness first.

### Layer 3 — Cross-session claims registry (medium; the concurrency win)

- Store `{workingDirectory, missionId}` metadata *inside* the touched-log and
  baseline JSON (filenames are opaque hashes today, so logs for the same cwd cannot
  be enumerated).
- At deliver, classify each dirty path:
  1. **Mine** — in my touched log → report, with prefilled draft rationale.
  2. **Claimed** — in another active session's touched log (and not mine) → exclude
     from my report; if the server still demands a rationale from a stale row,
     auto-attach a truthful skip entry ("changed by concurrent mission coo:NNN").
  3. **Unclaimed** — changed since my baseline, in nobody's log → **report it**
     (completeness first). With Bash capture in place these become rare; the CLI
     presents them explicitly so the agent confirms or skips in one step instead of
     re-deriving the whole tree.

### Layer 4 — Server-side reconciliation and self-servicing errors (contract touch)

- Deliver already receives the client's full current dirty set implicitly; add an
  explicit `observedDirtyPaths` so `deliverSession` can mark objective
  `changed_files` rows whose paths are no longer dirty as
  `current_diff_state = 'absent'`, un-poisoning coverage from past over-attribution.
- Make `missing_rationale` structured: per-path classification (mine / claimed /
  unclaimed) plus ready-to-use skip JSON, so a rejected deliver needs exactly one
  mechanical retry, never an investigation.
- Add `ovld protocol changes --mission-id <id>` as a preflight that prints the
  classified attributable set and drafted rationales; update the mission skill text
  to say "never triage `git status` by hand — run this."

### Contract impact

Layers 1–3 are client/adapter-only (no CONTRACT.md change). Layer 4 adds an optional
deliver field (`observedDirtyPaths`) and a structured error payload — additive DTO
changes affecting `packages/core/service/protocol.ts`, `backend/protocol.ts`, the
CLI, and both data layers' conformance tests; MCP shims pass the new field through
unchanged.

## Why not "require the agent to account only for the touched list" verbatim

Requiring rationales *only* for hook-observed files would be maximally efficient but
trades away completeness in exactly the cases that matter: Bash-mediated changes,
subagent edits, hook outages (the current state!), and any future tool the matcher
misses. The claims-based rule above achieves the same efficiency in the common case
— the agent is only ever asked about its own confirmed files plus a (rare, explicit,
pre-classified) unclaimed remainder — while guaranteeing that no dirty path is
silently unaccounted for.
