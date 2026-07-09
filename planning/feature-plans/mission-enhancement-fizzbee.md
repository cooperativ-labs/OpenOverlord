# Mission Enhancement via FizzBee — objective → checked spec (coo:206)

**Status:** exploration / assessment — no implementation yet.
**Prompt:** Explore [FizzBee](https://github.com/fizzbee-io/fizzbee) as a way to
automatically enhance missions a user writes.
**PM clarification (2026-07-08):** the feature should take a user's initial
objective and run it through the FizzBee process to **transform it into a spec**,
in the sense of [fizzbee.ai](https://fizzbee.ai/)'s own product framing.

## 1. What FizzBee is — two products

**fizzbee.ai (hosted, the framing the PM pointed at):** positions itself as "the
AI Requirements Engineer between your idea and your coding agent." Instead of
"try a longer prompt, add more context," you "answer a few questions, then prompt
once." Three-stage workflow:

1. **Elicitation** — targeted questions uncover decisions the initial prompt left
   unspecified.
2. **Analysis** — formal verification detects contradictions and requirement gaps
   systematically.
3. **Validation** — generates key scenarios so the user confirms the spec matches
   their expectations.

Output is a **"Product Specification" optimized for machine consumption** — built
for coding agents, not human documentation ("Specification-Driven Development").
It's a hosted SaaS behind auth; no public pricing, and as of this writing no
documented public API (needs confirmation — see open questions).

This is, almost verbatim, the feature this mission describes: a user's initial
objective in, a verified machine-readable spec out, consumed by the executing
agent. The strategic question is therefore **integrate fizzbee.ai vs. replicate
its loop on the open-source tooling**, not whether the idea works.

**fizzbee.io (open source, the verification kernel):**

A **formal specification language and model checker** for distributed
systems — an accessible TLA+ alternative. Apache-2.0, Go/Python, v0.5.x. A `.fizz`
spec is Python-like: state, actions, invariants/assertions, roles. Running
`fizz spec.fizz` exhaustively explores the state space and prints a
**counterexample trace** when an invariant can be violated; it also supports
probabilistic/performance analysis. Distribution: brew, prebuilt Linux/macOS
binaries, Docker, online playground — i.e. easy to put in an agent-pod image or
backend container.

Critically for us, FizzBee already ships **Agent Skills** (Claude Code / Cursor /
Gemini CLI standard): `fizz-spec` (writing specs), `fizz-check` (running the
checker), `fizz-debug` (fixing failing/slow specs), `fizz-mbt` (model-based test
adapters, Go). `fizz install-skills` drops the four SKILL.md files plus five
reference docs and six curated example specs into `~/.claude/skills/`. This is a
vendor-maintained knowledge pack that makes an LLM competent at a niche formal
language — exactly the hard part of our pipeline, already solved and kept current
upstream.

## 2. The feature: objective → checked spec

Mirroring fizzbee.ai's elicit → analyze → validate loop inside Overlord's mission
lifecycle. Pipeline, triggered on a draft objective (explicit "Enhance to spec"
action first; automation later):

0. **Elicit.** Before any spec is drafted, ask the user the questions their
   objective leaves open — scope, referents, expected behavior under the awkward
   interleavings. Overlord already has the exact conversational surface for this:
   the draft-objective **discussion** flow (`discuss-objective`, follow-up
   capture) and `ovld protocol ask`. Elicitation answers land as mission
   context/shared state, not lost chat.
1. **Extract the behavioral model.** From the user's objective text (+ cheap
   project context: linked resource dirs, CONTRACT.md excerpts, related code the
   user references), identify the state machine implied by the ask — entities,
   states, transitions, concurrent actors, the properties the user implicitly
   expects ("a delivered mission can't return to draft", "no two sessions hold the
   tx mutex", "every outbox message is dispatched exactly once").
2. **Draft a `.fizz` spec** encoding that model: actions for each transition,
   invariants/assertions for each expected property. The drafting agent works
   under FizzBee's own `fizz-spec` skill + bundled examples, so we don't hand-write
   or maintain prompt guidance for the language.
3. **Model-check it** with the `fizz` CLI. On invariant violation, the loop
   (guided by `fizz-check`/`fizz-debug`) decides: is the spec wrong, or did the
   checker just find a real hole in the user's intent? Spec bugs get fixed and
   re-checked; genuine design holes become surfaced findings.
4. **Attach the result to the mission**: the checked `.fizz` spec as a mission
   artifact, plus a human-readable enhancement of the objective — the invariants
   in plain language, edge cases the checker exercised, and any counterexample
   traces reframed as "your objective as written allows this bad sequence —
   decide: forbid it or accept it."
5. **Validate with the user** (fizzbee.ai's third stage): alongside the plain-
   language invariants, present 2–3 generated concrete scenarios ("user does X
   while Y is mid-flight → system does Z") for the user to confirm or correct
   before the spec is accepted onto the mission.
6. **Downstream execution** objectives inherit the spec: the implementing agent
   is instructed to treat the invariants as acceptance criteria (and can re-run
   `fizz` if it changes the design). The vague prose objective has become a
   machine-verified contract.

The enhancement value is concentrated in steps 3–4: today an under-specified
objective's holes are discovered mid-implementation (or as a blocking `ask`);
this moves the discovery to mission-creation time, with a checker rather than an
agent's judgment finding the holes.

### Where the pipeline runs

Spec-writing is inherently **iterative** (draft → check → read trace → fix), so a
single Gemini call via `@overlord/automations` won't cut it. Three candidate homes:

- **C. Integrate fizzbee.ai directly.** If it exposes (or will expose) an API,
  Overlord's enhance action posts the objective + context, relays elicitation
  questions through the mission discussion flow, and stores the returned Product
  Specification as a mission artifact. Least build effort and we inherit their
  loop verbatim; but it's an early closed SaaS with unknown API/pricing/data
  terms, and Overlord is open-source — a hard dependency on a hosted service
  can't be the only path. Worth a conversation with the FizzBee team (they're
  clearly courting the coding-agent orchestration use case), while keeping A as
  the self-hosted implementation of the same shape.
- **A. Self-hosted enhancement run (recommended default).** Reuse Overlord's own machinery:
  the enhance action creates a lightweight internal objective ("transform this
  objective into a checked FizzBee spec") executed by a normal agent session in a
  pod that has the `fizz` binary + FizzBee skills installed. Deliverables come
  back as mission artifacts through the existing deliver path. Almost no new
  infrastructure — it's dogfooding: mission enhancement is itself a mission.
  Cost: an agent run per enhancement; acceptable while the action is explicit.
- **B. Backend automation loop.** A bounded loop in `@overlord/automations`
  (sibling to `title-summarizer`): `generateGeminiText` drafts the spec, backend
  shells out to `fizz`, feeds errors back, N iterations max. Cheaper per run and
  no pod needed, but we'd re-implement agentic iteration and re-encode the skill
  guidance into prompts — fighting the framework. Consider later as a fast path
  for simple specs.

### Existing substrate this builds on

- `@overlord/automations`: automation registry + working Gemini client with
  no-key fallback (`title-summarizer` already AI-generates objective titles;
  `backend/commit-message-automation.ts` sets the draft-then-human-review
  precedent).
- Objective lifecycle **draft** state: enhancement happens pre-submission, and the
  user reviews the spec + reframed objective before anything executes.
- Mission artifacts + attachments: natural home for the `.fizz` file and checker
  output (artifact types `note`/`decision` today; likely a new `spec` artifact
  type — contract + `ticket_events`-style enum check to touch, see CONTRACT.md).
- Agent-pod skill installation: FizzBee's installer already targets
  `~/.claude/skills/`, which pods use.

## 3. Honest scope caveat

FizzBee specs model **stateful/concurrent behavior**. Overlord has plenty of that
(objective lifecycle, delivery states, session/follow-up flow, outbox/webhook
dispatch, branch/worktree ownership) — and missions about such behavior are where
this shines. But a large share of missions ("add a dropdown", "fix this copy",
"rename X") have no meaningful state machine; forcing a spec there produces
ceremony, not rigor. So:

- Step 1 must include a **classifier gate**: if no non-trivial behavioral model is
  found, the feature degrades to a plain structured enhancement (clarified
  objective, acceptance criteria, missing referents — e.g. this very mission's
  "Explore this" with a dangling referent) and says so, rather than emitting a
  toy spec.
- Keep the action **explicit and per-objective** initially; consider auto-trigger
  heuristics only after we see real usage.

## 4. Suggested phasing

1. **Phase 1 — prove the transform.** Pod image gains `fizz` + skills. A single
   hand-triggered flow (Option A) on a real design-heavy mission (e.g. webhook
   dispatch ordering or follow-up session states); attach spec + findings as
   artifacts. Measures: does the checker find intent holes the user cares about?
2. **Phase 2 — productize the action.** "Enhance to spec" on the draft-objective
   editor + `ovld protocol enhance --mission-id …`; new `spec` artifact type in
   the contract; classifier gate with plain-enhancement fallback.
3. **Phase 3 — inherit downstream.** Executing objectives automatically receive
   the spec artifact in launch context with instructions to treat invariants as
   acceptance criteria; optionally re-check on deliver.

Open questions for the PM:
0. Does fizzbee.ai expose an API / partner program (Option C)? Worth reaching out
   before building Phase 1, even if we keep the self-hosted path regardless.
1. OK to spend an agent run per enhancement (Option A), or is a cheaper backend
   loop (Option B) a requirement from day one?
2. Should the plain-language reframing **replace** the user's objective text on
   accept, or attach alongside it? (Recommend: alongside; objective text stays
   the user's words.)
3. Any appetite for surfacing counterexample traces in the webapp UI (step-by-step
   state table), or is artifact-file-plus-summary enough for v1?
