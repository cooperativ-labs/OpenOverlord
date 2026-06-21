# Reducing Agent Delivery Friction (coo:18)

## The question being answered

Three delivery problems keep recurring across agent runs. For each, the PM asked
whether the right response is **(a) explicit instructions**, **(b) let the agent
figure it out each time**, or **(c) a better fix** (usually a change to the tool
itself). This document diagnoses each from the code and gives a verdict, plus a
general principle for making the instruction-vs-tooling call going forward.

Related but distinct from [deliver-step-efficiency.md](deliver-step-efficiency.md)
(coo:17), which is about the *token/time cost* of producing a delivery. This one is
about *correctness/retries* — deliver and update keep failing and getting retried
because of confusing conventions.

---

## Guiding principle (the decision framework)

Rank the three responses by how the cost is paid:

1. **Fix the tool** — pay once; the failure class disappears for *every* agent, on
   *every* connector, forever. Deterministic.
2. **Explicit instruction** — pay per agent, per run, in context budget; only
   *probabilistically* effective (agents don't always read or recall a given line,
   and docs rot). Issues 1 and 3 below are *already documented* and still recurred —
   that is the empirical proof that instruction alone does not close a mechanical trap.
3. **Let the agent figure it out** — pay a full retry cycle (tokens + wall-clock +
   a confusing error in the PM's activity feed) on *every* run, forever.

So the default ordering is **tool fix > instruction > improvisation**. Reserve
"explicit instruction" for things the tool genuinely cannot disambiguate (judgment
calls like "write the summary as a narrative, not a command list"). Reserve "let the
agent figure it out" for *genuinely novel* situations — a friction we have already
seen and named is, by definition, not novel.

**On per-connector customization** (raised in the ticket for issue 2): all three of
these live in the *shared* CLI + backend envelope, not in any one harness. A
shared-layer fix covers Claude, Codex, Cursor, and every future connector at once. N
per-connector doc workarounds drift and rot. Reserve per-connector customization for
*genuine harness differences* (e.g. how a particular shell handles heredocs/stdin) —
not for papering over a shared-CLI quirk.

---

## Issue 1 — "The progress update needs the session key explicitly in this shell"

**Root cause (documentation contradicts the code).**
`connectors/core/overlord-ticket/SKILL.md:17` promises the CLI "persists this key
automatically so subsequent `ovld protocol` commands in the same working directory
resolve it without `--session-key`." The code does not do this:

- `update` and `deliver` hard-require the key: `requireFlag(body, '--session-key')`
  (`webapp/server/protocol.ts:207` and `:252`).
- The CLI never persists or re-injects the key — `runProtocolCommand`
  (`cli/src/commands.ts:256-333`) just prints it from the attach response.
- Every Bash tool call is a *fresh shell*, so a key captured at attach is gone by the
  next command unless the agent threads it through manually.
- A `externalSessionId` fallback *does* exist, but only for `hook-event` /
  `resume-follow-up` (`resolveFollowUpObjective`, `src/service/protocol.ts:592-626`),
  not for `update`/`deliver`. For Claude it relies on a cached native session id
  (`native-session.ts:130-131`) that often does not exist in a pod shell.

So the agent isn't doing anything wrong — it's obeying a doc that overstates reality,
hitting a hard requirement, and recovering with a retry.

**Verdict: tool fix, with an honest-docs stopgap. Not "figure it out," not docs alone.**

- *Immediate (instruction layer, cheap + honest):* correct `SKILL.md:17` to stop
  promising auto-resolution. State plainly: "every protocol call after attach needs
  `--session-key`; capture it from the attach response and pass it explicitly." The
  reference examples (`reference/cli.md`) already pass it, so only the SKILL claim is
  wrong.
- *Durable (the real fix):* make the promise true. At `attach`, have the CLI cache the
  returned session key keyed by `(resolve(workingDirectory), ticketId)` — exactly the
  pattern `native-session.ts` already uses for `externalSessionId` — and auto-inject
  `--session-key` in `runProtocolCommand` when the flag is absent. Deterministic,
  connector-agnostic, and it makes the existing documentation correct.
  - Guardrails: scope the cache to `(workingDir, ticket)`; clear it when the session
    ends (deliver/complete) so a stale key can't attach to a new session; an explicit
    `--session-key` always wins over the cache.
  - Weaker alternative: let `update`/`deliver` fall back to `externalSessionId`
    resolution like `resolveFollowUpObjective` does. Rejected as the primary fix
    because Claude-in-a-pod has no reliable native id to fall back on.

---

## Issue 2 — "deliver only accepts one stdin payload at a time"

**Root cause (the envelope collapses all file flags into one stdin field).**

- The CLI's `resolveProtocolStdin` (`cli/src/commands.ts:223-243`) loops the
  `--*-file` flags and returns the **first** one's content into a single `stdin`
  string. Everything else is dropped.
- The backend's `resolveInput` / `parseJsonInput` (`webapp/server/protocol.ts:90-133`)
  then read `body.stdin` for **any** file-flag they see.
- Net effect: passing `--summary-file -` *and* `--change-rationales-file -` in one
  heredoc routes the same blob to both. The summary heredoc gets fed to the rationale
  parser and "parsed as JSON," which is exactly the reported failure.

Current docs (`reference/cli.md:70-82`) already prescribe the workaround — keep
`--summary` inline, pipe rationales on stdin — but the failure is *silent*: nothing
warns the agent it just sent two payloads down one pipe.

**Verdict: tool fix, graduated. Keep the doc workaround until the structured fix ships.**

- *Immediate (tiny, high value):* make the ambiguity **fail fast**. If more than one
  stdin-consuming flag (value `=== '-'`) is present, throw a `CliError` naming the two
  flags and the fix ("pipe only one payload on stdin; pass the other inline or via a
  file path"). This converts a silent mis-parse into a guided correction — issue 2 stops
  being a "figure it out" and becomes a one-line, self-explaining error. A few lines in
  `resolveProtocolStdin`.
- *Durable (removes the limit):* resolve **each** `--*-file` flag independently instead
  of into one shared `stdin`. Send a structured `fileInputs` map in the envelope
  (`{ '--change-rationales-file': '<content>', '--summary-file': '<content>' }`); the
  backend reads the per-flag entry rather than `body.stdin`. At most one flag may still
  use literal `-` (true stdin); real file paths have no limit. This lets an agent pipe
  rationales *and* stream a long summary in one call.
- *Per-connector note from the ticket:* the limit is in the shared CLI + backend, so the
  fix is shared. The only legitimately connector-specific part is how a harness's shell
  handles heredocs — document that per connector if needed, but do **not** fork the
  payload-routing logic.

---

## Issue 3 — "the rationale matcher keys on file_path (snake_case), not filePath"

**Root cause (a genuine internal inconsistency in the API).**

- Rationales use snake_case: `ChangeRationaleInput.file_path`
  (`src/service/protocol.ts:1204`), and the coverage matcher compares
  `r.file_path === file.file_path` (`:1287`).
- Changed-files use camelCase **everywhere**: `filePath`
  (`webapp/server/protocol.ts:183`, `cli/src/commands.ts:29`, `cli/src/vcs.ts:31`).
- An agent that just saw `filePath` work for changed-files reasonably generalizes it to
  rationales — and gets rejected. The docs warn about this (`reference/cli.md:105`,
  `SKILL.md:89`), and it *still* recurs. That is the clearest evidence in the set that
  documentation cannot fix a casing trap.

**Verdict: tool fix — accept both casings (normalize at the boundary).**

- Make the rationale parser treat `filePath` as an alias for `file_path` (normalize in
  the CLI before send, or in the backend before `deliverSession`), so downstream stays
  canonical snake_case. Optionally tolerate `rationale`/`summary` aliasing too, or at
  least error precisely on it.
- This is additive and backward-compatible: `file_path` stays canonical, `filePath` is
  accepted. Docs keep teaching the canonical form, but correctness no longer depends on
  the agent getting the casing right.
- Larger end-state (optional): make the *whole* protocol consistent (one casing for both
  changed-files and rationales). Aliasing is the low-risk first step toward that.

---

## Summary

| Issue | Verdict | Immediate | Durable |
|---|---|---|---|
| 1 — session key required | tool fix + honest docs | correct `SKILL.md:17`; always pass `--session-key` | CLI caches key at attach, auto-injects when absent |
| 2 — one stdin payload | tool fix (graduated) | fail-fast when >1 `-` flag is passed | per-flag `fileInputs` map in the envelope |
| 3 — `file_path` vs `filePath` | tool fix | (none needed) | accept `filePath` as an alias for `file_path` |

All three resolve to **fix the tool**, because all three are recurring, deterministic,
already-named traps — not novel situations and not judgment calls. Instruction is the
stopgap for issue 1 only; improvisation ("let the agent figure it out") is the right
answer for *none* of them.

---

## Contract impact

- **Issue 1:** if fixed client-side (CLI cache + auto-inject), no envelope/contract field
  changes. If the backend `externalSessionId` fallback is chosen instead, document it on
  `update`/`deliver` in `contract/protocol-commands.yaml`.
- **Issue 2 (structured fix):** adds a `fileInputs` map to `ProtocolRequestBody` →
  note in `contract/components.yaml` + `contract/protocol-commands.yaml`. Backward
  compatible (`stdin` still honored). The fail-fast guard alone needs no contract change.
- **Issue 3:** additive alias; document `file_path` as canonical with `filePath` accepted
  in `contract/protocol-commands.yaml`, `reference/cli.md`, and `SKILL.md`.

## Recommended sequencing

1. **Issue 3 alias** — smallest change, removes a whole failure class.
2. **Issue 2 fail-fast guard** — tiny; turns a silent mis-parse into a guided error.
3. **Issue 1 doc correction** (immediate) **+ session-key cache/auto-inject** (the real fix).
4. **Issue 2 structured `fileInputs` envelope** — larger; do after the guard proves demand.

## Open questions for the PM

- Issue 1: prefer the client-side CLI key cache (recommended) or the backend
  `externalSessionId` fallback? The cache is more reliable for Claude-in-a-pod.
- Issue 2: is the fail-fast guard enough for now, or should the structured multi-payload
  envelope be built immediately?
- Issue 3: ship the `filePath` alias only, or also unify the protocol on a single casing
  for both changed-files and rationales (larger, breaking-ish) as a follow-up?
- Should these fixes land as the ticket's second (currently empty) objective, or be split
  into their own tickets?
