# Optimizing the Deliver Step (coo:17)

## Problem

`ovld protocol deliver` can take ~3 minutes and ~6000 tokens. That cost is **not** in
the CLI or backend — both are fast. It is the *agent* (Claude Code) re-doing analysis
at the end of a run to produce the delivery payload:

1. **Per-file `changeRationales`** — for every meaningful changed file the agent must
   emit `label`, `summary`, `why`, `impact`. `deliverSession` (`src/service/protocol.ts:1287`)
   rejects the delivery if any meaningful file (present diff, non-`package-lock`) lacks a
   rationale with all four fields filled. With 5–15 changed files that is 20–60 prose
   fields, each requiring the agent to re-read a diff it already wrote.
2. **The narrative `summary`** — the PM-facing report.
3. **Re-derivation cost** — by deliver time the relevant diffs have often scrolled out of
   the agent's active attention, so it re-reads files/`git diff`, re-burning tokens and
   wall-clock on context it already had earlier in the session.

What is *already* efficient and should stay that way: changed-file **enumeration** is
mechanical (`cli/src/vcs.ts` — baseline snapshot at attach ∩ PostToolUse touched-files
log), so the agent never hand-lists files. The expensive remainder is *explaining* those
files.

Key enabling facts found in the codebase:
- Claude Code hook payloads already carry `transcript_path` (full JSONL of the session),
  and a `PostToolUse` hook already runs on every edit
  (`connectors/adapters/claude/scripts/post-tool-use-hook.sh`).
- There is **no** LLM/API call anywhere in the backend or CLI today — a "second built-in
  LLM" would be net-new infrastructure.
- The agent catalog already lists `claude-haiku-4-5` (`cli/src/agent-catalog-defaults.ts`),
  the natural cheap model for offloaded summarization.

## Goal

Move rationale/summary generation **off the main agent's critical path and context
budget** so deliver becomes near-instant for the agent, while keeping (or improving)
report quality. Three complementary tracks, roughly in cost/impact order.

---

## Track A — Incremental capture (cheapest, no new LLM)

Stop saving all rationale work for the end. The information needed for a rationale is
freshest *at the moment of the edit*, not 30 turns later.

- **A1. PostToolUse already knows the file.** Extend the existing edit hook to stash, per
  touched file, the surrounding context it can cheaply get: the tool name, the
  `old_string`→`new_string` intent, and (optionally) the user/assistant message that
  prompted the turn from `transcript_path`. Store this next to the touched-files log
  (`vcs-touched/<key>.json` → add a parallel `vcs-rationale-notes/<key>.json`).
- **A2. At deliver, pre-fill rationales from those notes.** `deliver` reads the notes and
  emits draft `changeRationales`; the agent only *reviews/edits* them instead of authoring
  from scratch. Even a mechanical draft (label = derived from path/diff stat, summary =
  last edit intent) collapses most of the per-file token cost.
- **A3. Encourage `ovld protocol record-change-rationales` mid-run.** The command already
  exists. Nudge the agent (via the Stop hook guidance and SKILL) to record a rationale
  right after finishing each file while context is hot, so deliver is just a flush.

Pros: no model cost, no new dependency, reuses existing hook + log plumbing.
Cons: hook-derived drafts are lower quality than reasoned rationales; still needs agent
review. Best combined with Track B.

---

## Track B — Offload to a second, built-in LLM using the transcript (the core ask)

Introduce a cheap server- or CLI-side model (Haiku 4.5) that generates the delivery
report **from the work that already happened**, so the expensive Opus agent doesn't spend
its budget re-explaining itself.

### Inputs the second LLM gets
- The session **transcript** (`transcript_path` JSONL — already available to hooks). This
  is the gold input: it contains the reasoning, the edits, and the user's objective.
- The mechanical **changed-file list + per-file `git diff`** (computed client-side, never
  leaves the box if the model runs locally/edge).
- The **objective text** from the ticket.

### Output
- A draft `summary` (narrative) and a full set of `changeRationales` (one per meaningful
  file, all four fields), shaped exactly to what `deliverSession` validates.

### Where it runs — three options
- **B1. CLI-orchestrated, API-backed (recommended first step).** `ovld protocol deliver`
  gains a `--draft-from-transcript` mode: the CLI reads the transcript + diffs, calls the
  Anthropic API with Haiku, and prints/staged the draft payload. The Opus agent either
  skips authoring entirely or just approves. Cost moves from ~6000 Opus tokens to a few
  thousand Haiku tokens (~10–20× cheaper) **and** off the agent's wall-clock.
- **B2. Backend-side generation.** The CLI uploads transcript + diffs (privacy decision
  required — diffs currently never leave the client per `cli/src/vcs.ts`); the backend
  runs the model and stores the draft delivery for the PM to see immediately. Best for
  centralized model-key management and consistency, worst for privacy/data-egress.
- **B3. Fully automated deliver.** The Stop hook (which already detects pending delivery)
  triggers B1 and submits the delivery without a further agent turn — the agent's job ends
  at "work done," and the rationale/summary LLM produces and submits the report. This is
  the end-state that removes the deliver step from the agent loop entirely.

### Why the transcript is the right source
The transcript already encodes *why* each change was made (the agent literally reasoned
about it). A summarizer over the transcript reconstructs `why`/`impact` far more cheaply
than asking Opus to regenerate that reasoning, because it's extraction/compression, not
fresh problem-solving — exactly the workload a small model is good at.

### Important design constraints
- **Schema-locked output.** Have Haiku emit JSON matching `ChangeRationaleInput`
  (`file_path`, `label`, `summary`, `why`, `impact`) so it flows straight into the
  existing validation with no reshaping. Use the model's structured/tool-output mode to
  guarantee shape.
- **Coverage contract.** The generator must produce a rationale for exactly the set
  `deliverSession` requires (meaningful files = present diff, non-`package-lock`). Feed it
  that exact file list so it can't under/over-cover and trip the `missing_rationale` /
  `invalid_rationale` errors.
- **Human/agent in the loop (initially).** Ship as *draft* first; let the agent approve
  before submit. Promote to fully-automatic (B3) once quality is trusted.
- **Privacy.** Diffs and transcripts are sensitive. Prefer B1 (data stays client-side,
  only the model call goes out) over B2 unless there's a reason to centralize. Make the
  data-egress boundary an explicit, documented decision and a config flag.

---

## Track C — Reduce the work that needs explaining at all

- **C1. Right-size the coverage requirement.** Today every meaningful file needs a full
  4-field rationale. Consider tiering: trivial/mechanical files (generated types, lockless
  config, re-exports) get an auto-generated one-line rationale; only substantive files get
  the full treatment. This shrinks the N in the per-file cost.
- **C2. Cache diffs the agent already saw.** If a file's diff hasn't changed since the
  agent last reasoned about it (hash already tracked in `vcs.ts`), reuse the earlier
  reasoning instead of re-reading.
- **C3. Stream rationales as artifacts, not inline argv.** Already a known sharp edge
  (oversized `--*-json` rejected; memory note `ovld-deliver-flag-quirks`). Standardize on
  `--change-rationales-file -` for the generated payload to avoid retries that themselves
  burn time/tokens.

---

## Recommended sequencing

1. **Track A2 + A1** — pre-fill rationale drafts from hook-captured edit notes. Pure
   plumbing, immediate win, no model risk.
2. **Track B1** — CLI `--draft-from-transcript` with Haiku, output as reviewable draft.
   This is the single biggest lever and directly answers the "offload to a second
   built-in LLM via transcripts" ask. Keep diffs client-side.
3. **Track C1** — tier the coverage requirement so fewer files need full rationales.
4. **Track B3** — once draft quality is trusted, let the Stop hook auto-generate and
   submit, removing deliver from the agent's loop entirely.

## Open questions for the PM
- Acceptable data-egress boundary: is sending transcript/diffs to the Anthropic API (B1)
  fine, or must generation be fully local? This gates B1 vs B2.
- Is a *draft-then-approve* flow acceptable as the first ship, or is the goal full
  automation (B3) from the start?
- Should the coverage requirement (C1) actually be relaxed, or is full per-file rationale
  coverage a hard product requirement regardless of cost?
