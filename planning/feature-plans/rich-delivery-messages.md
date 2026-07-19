# Rich Delivery Messages: Tradeoffs, Human Actions, and AI Composition

Status: recommendation and implementation plan (mission `coo:364`). No product
implementation is included in this objective.

## Recommendation

Use a hybrid delivery pipeline:

1. The coding agent reports source facts:
  - a concise fallback summary
  - `humanActions`
  - `tradeoffsMade`
  - existing artifacts, verification summary, and file change rationales
2. The protocol commits the delivery immediately, using the agent summary and
  source facts to build a deterministic presentation.
3. A background Automations job asks Gemini to compose a polished Markdown
  presentation and normalize the structured callouts.
4. The UI displays the composed presentation when ready and otherwise displays
  the deterministic version. Delivery never waits for Gemini.

The coding agent should not be responsible for the final presentation JSON, and
Gemini should not be the source of truth for what the agent decided or what the
human must do. The agent has first-hand knowledge of those facts; Gemini is better
used as an editor and organizer.

This differs in one important way from making Gemini generate everything from the
mission record: inferred tradeoffs can sound plausible while being false, and
inferred human actions can create unnecessary work. The final payload should keep
agent evidence separate from AI-composed presentation and retain provenance on
each structured item.

## Direct Answers



### Should the coding agent compose the JSON?

The agent should compose a small, typed evidence object, not the full display
document. It should always provide arrays, using `[]` when there is nothing to
report:

```json
{
  "summary": "Immediate Markdown fallback.",
  "agentReport": {
    "humanActions": [],
    "tradeoffsMade": []
  },
  "artifacts": [],
  "changeRationales": []
}
```

Connector instructions should make `humanActions` and `tradeoffsMade` expected
agent behavior. The protocol must accept their absence and normalize it to empty
arrays so old connectors, missed fields, and non-coding agents cannot be prevented
from delivering.

In other words, they are required by agent guidance but optional on the wire for
backward compatibility and operational resilience. Missing arrays should produce
observability, not a delivery error.

### Should Gemini compose the message?

Yes, asynchronously. Gemini should receive bounded, secret-redacted source
context and return a schema-constrained presentation:

- main Markdown
- normalized human action cards
- normalized tradeoff cards
- optional review highlights, risks, and known limitations

Gemini may deduplicate, shorten, categorize, and rephrase source facts. It should
not invent mandatory actions or implementation decisions. A tradeoff must cite an
agent-reported tradeoff or a change rationale. A human action must cite an
agent-reported action or a deterministic operations rule. Each item should carry
provenance so the UI can distinguish `agent`, `change_rationale`, and
`deterministic_rule` sources.

### What else would improve visibility?

The highest-value additions, in priority order, are:

1. `knownRisks`: residual risks or limitations left after delivery. INCLUDE THIS 
2. `deferredWork`: intentionally excluded or postponed work, distinct from a
  human action. INCLUDE THIS
3. `assumptions`: material assumptions that influenced the implementation. INCLUDE THIS
4. `verification`: checks actually run and notable checks not run. Continue to
  use the existing `verification_summary` column as the canonical input. DIFFERED 
5. `operationalImpact`: migration, configuration, deployment, code generation,
  packaging, or external-service consequences. DIFFERED
6. `compatibilityImpact`: behavior or schema compatibility constraints. DIFFERED

Avoid turning the drawer into an automatically generated audit essay. File-level
details already belong to change rationales, and routine instructions such as
"review the code", "test the feature", or "verify it works" should never become
human actions.

## Lessons From the Upstream Feed Generator

The referenced
`Overlord-v1` [generator](https://github.com/cooperativ-labs/Overlord-v1/tree/main/supabase/functions/generate-feed-post)
provides a useful pattern:

- It reads objective context, chronological events, file rationales, spawned work,
and project-specific instructions.
- It asks Gemini for schema-constrained JSON rather than parsing prose.
- It caps and sanitizes every returned array and string.
- It derives candidate operational actions deterministically from changed paths.
- It excludes routine QA from human actions.
- It uses a deterministic fallback whenever Gemini is unavailable or malformed.
- It treats generation failure as non-fatal to the delivery/status transition.

Those properties should be retained. The delivery version should be smaller and
more source-disciplined than the feed generator because it is a review boundary,
not a broad ticket rollup.

## Current-State Findings

The present codebase already has most of the necessary seams:

- `deliverSession()` in `packages/core/service/protocol.ts` is the transactional
delivery choke point.
- `deliveries.payload_json` already stores arbitrary structured payload data, so
this feature does not need new delivery columns.
- `deliveries.summary`, `verification_summary`, and `follow_up_notes` already
provide durable fallback/source fields.
- `change_rationales` already contains decision-adjacent evidence: summary, why,
and impact.
- `worker_jobs` already exists in the schema specifically for durable non-agent
background work, although no general worker currently consumes it.
- The Automations layer already provides optional Gemini calls, `null` fallbacks,
provider configuration, and caller-supplied persistence boundaries.
- The activity UI currently renders only `MissionEventDto.summary`.
`mission_events.payload_json` contains the `deliveryId`, but the REST projection
drops it.
- The shared REST contract intentionally has no `DeliveryDto`; the SPA cannot
currently fetch or render `deliveries.payload_json`.
- `ovld mission deliveries` currently aliases the mission-events endpoint rather
than returning delivery records.
- Hosted MCP delivery accepts summary and change rationales but not artifacts,
tradeoffs, human actions, verification, or follow-up notes.

The data exists at delivery time, but the read-side and agent surfaces need to be
made consistent.

## Proposed Data Contract

Define these types in `@overlord/contract` and document the storage form in the
protocol and database contracts:

```ts
type DeliveryEvidenceSource = 'agent' | 'change_rationale' | 'deterministic_rule';

interface HumanActionV1 {
  id: string;
  action: string;
  reason?: string;
  category:
    | 'environment'
    | 'database'
    | 'deployment'
    | 'codegen'
    | 'packaging'
    | 'external_service'
    | 'other';
  blocking?: boolean;
  source: DeliveryEvidenceSource;
  sourceRef?: string;
}

interface TradeoffMadeV1 {
  id: string;
  decision: string;
  alternativesConsidered: string[];
  rationale: string;
  impact?: string;
  source: 'agent' | 'change_rationale';
  sourceRef?: string;
}

interface DeliveryAgentReportV1 {
  humanActions: HumanActionV1[];
  tradeoffsMade: TradeoffMadeV1[];
  knownRisks?: string[];
  deferredWork?: string[];
  assumptions?: string[];
  compatibilityImpact?: string[];
}

interface DeliveryPresentationV1 {
  status: 'deterministic' | 'pending' | 'composed' | 'fallback';
  markdown: string;
  humanActions: HumanActionV1[];
  tradeoffsMade: TradeoffMadeV1[];
  reviewHighlights?: string[];
  knownRisks?: string[];
  deferredWork?: string[];
  generatedBy: 'deterministic' | 'gemini';
  generatedAt?: string;
  model?: string;
}

interface DeliveryReportPayloadV1 {
  schemaVersion: 1;
  agentReport: DeliveryAgentReportV1;
  presentation: DeliveryPresentationV1;
}
```

Store it under a versioned top-level key:

```json
{
  "deliveryReport": {
    "schemaVersion": 1,
    "agentReport": {},
    "presentation": {}
  }
}
```

Do not overwrite `deliveries.summary` with Gemini output. The summary is the
original, immediately committed agent narrative and permanent fallback.
`presentation.markdown` is the mutable read-side composition. This preserves the
source record, makes regeneration safe, and lets reviewers understand which text
was agent-authored.

The REST `DeliveryDto` should expose the normalized report rather than raw
`payload_json`:

```ts
interface DeliveryDto {
  id: string;
  missionId: string;
  objectiveId: string;
  sessionId: string | null;
  summary: string;
  verificationSummary: string | null;
  followUpNotes: string | null;
  report: DeliveryReportPayloadV1;
  deliveredAt: string;
  agentIdentifier: string | null;
  modelIdentifier: string | null;
}
```

Legacy deliveries receive an in-memory deterministic `report` derived from their
summary and existing fields; no eager backfill is required.

## Human Action Policy

The policy must be deterministic and shared by protocol validation, the
automation prompt, and tests.

Allowed examples:

- add or rotate an environment variable
- run a migration or code generator
- deploy a service/function
- repackage a desktop application
- create or configure an external account, credential, webhook, or integration
- perform a manual data operation the agent cannot perform

Always excluded:

- commit, push, pull, merge, rebase, create a branch, or open a pull request
- review the code
- run ordinary tests or "verify it works"
- generic monitoring with no concrete required action
- work the agent could and should have completed inside the objective

Implement the exclusion as a normalized filter over category plus text patterns.
The agent prompt should prevent most noise; the server filter is the final guard.
Filtered entries may be counted in debug telemetry but should not be stored in the
presentation.

## End-to-End Flow

```text
coding agent
  -> protocol delivery envelope (summary + evidence + existing artifacts/rationales)
  -> transactional delivery commit
       - store original summary and normalized agent report
       - build/store deterministic presentation
       - insert delivery event
       - enqueue one compose job keyed by delivery id
  -> protocol returns success immediately

background delivery-composition worker
  -> load bounded delivery/objective/event/rationale context
  -> derive deterministic candidate actions
  -> ask Gemini for schema-constrained presentation
  -> sanitize, source-check, and merge with authoritative evidence
  -> update deliveries.payload_json + revision
  -> append entity_changes(entity_type = "delivery")

SPA
  -> render event summary immediately
  -> click delivery event
  -> lazy-load DeliveryDto
  -> render composed presentation or deterministic fallback
  -> realtime delivery change invalidates and refreshes the open drawer
```



### Delivery transaction

The transaction must never call Gemini. It should:

1. Validate bounded evidence strings and arrays.
2. Normalize missing report fields to empty arrays.
3. filter prohibited human actions.
4. Build the deterministic presentation from the summary and evidence.
5. Store the versioned payload.
6. Insert a single `worker_jobs` row with type
  `overlord.delivery.compose.v1` and `{ deliveryId }`.
7. Complete the existing objective, mission event, webhook, and status mutations.

Use a uniqueness/idempotency strategy keyed by delivery ID. If adding an index is
not desirable, the worker can treat duplicate jobs as safe because the output
update is idempotent; an explicit unique idempotency key is preferable.

When `GEMINI_API_KEY` is absent, either omit the job or let the worker immediately
mark the deterministic presentation `fallback`. In both cases the user sees a
complete message.

### Background worker

Add an in-process, database-backed worker modeled on the webhook dispatcher:

- atomic queued-to-running claim
- lock expiry for process crashes
- bounded retry with backoff
- Local and Cloud support using the same database queue
- no request-lifecycle dependency
- idempotent regeneration by delivery ID

The worker calls a new built-in `compose-delivery` automation through the existing
Service-to-Automations surface. The automation receives data only; it has no
database imports. Backend caller-supplied code owns context loading and
persistence.

The prompt should include:

- agent summary and report
- objective title/instructions, bounded
- verification and follow-up notes
- relevant delivery artifacts, bounded
- final change rationales for this delivery
- selected mission events for this objective/session
- deterministic action candidates

Do not send raw diffs, attachments, secrets, environment values, tokens, or
unbounded mission history.

The response must use the Gemini JSON response schema. After parsing:

1. cap lengths and item counts
2. drop unknown fields
3. drop invented tradeoffs with no source match
4. drop invented actions with no agent/rule source
5. apply the git/QA exclusion filter
6. preserve stable source IDs and provenance
7. update only `deliveryReport.presentation`

On any provider, parse, validation, or persistence failure, retain the
deterministic presentation. The delivery stays delivered.

## UI Recommendation

Keep collapsed activity entries compact. A delivery event should be visually
clickable and open a detail card or drawer.

The expanded order should be:

1. Main Markdown delivery message.
2. Human actions in a light blue section.
3. Tradeoffs in an amber/yellow section.
4. Verification, known risks, and deferred work in neutral sections.
5. Existing links to artifacts and file changes.

Human action card:

- action as the title
- short reason
- category icon/label
- blocking badge only when explicitly reported
- optional provenance tooltip

Tradeoff card:

- decision as the title
- rationale
- alternatives considered
- impact when present
- optional provenance tooltip

Hide empty sections. Do not display an error when Gemini is unavailable; show the
deterministic content normally. While an enrichment job is pending, the drawer can
show a quiet "Adding delivery details…" indicator, then refresh through realtime.

The exact requested tones:

- Human actions: blue border/background, including dark-mode equivalents.
- Tradeoffs: amber/yellow border/background, including dark-mode equivalents.

Accessibility requirements:

- color is not the only distinction; use headings and icons
- sufficient contrast in light and dark modes
- keyboard-operable event expansion and drawer dismissal
- semantic lists for actions and tradeoffs



## Contract-First Changes

This feature changes stable protocol and REST shapes across components. Before
implementation:

1. Bump the component contract version.
2. Add the versioned delivery-report payload and new optional protocol inputs to
  `CONTRACT.md` and `contract/protocol-commands.yaml`.
3. Add `overlord.delivery.compose.v1` as a core open-vocabulary
  `worker_jobs.type` in the database schema contract.
4. Define the `DeliveryDto`, evidence, and presentation types in
  `@overlord/contract`.
5. Document the existing/new `GET /api/missions/:id/deliveries` read surface and
  the additive `deliveryId` field on delivery mission events.
6. Update the webhook full-payload contract so `delivery.report` can be included
  without exposing raw `payload_json`.

The change is additive for old clients, but a contract version bump is appropriate
because the report schema becomes a stable cross-component interface.

## Component Impact


| Component        | Impact                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol         | Parse and validate the delivery evidence envelope; normalize legacy calls; persist deterministic report; enqueue composition work.                                                                                                                    |
| Database         | No delivery-table migration. Reuse `deliveries.payload_json`, `revision`, and existing `worker_jobs`; document the new core job type. Add an index only if needed for job idempotency/claim performance.                                              |
| CLI              | Make `--payload-json/--payload-file` a real delivery envelope as documented, extracting summary, agent report, artifacts, and rationales. Keep existing individual flags working. `ovld mission deliveries` should call the real deliveries endpoint. |
| Connector        | Update canonical delivery instructions once so every adapter asks for human actions and tradeoffs with empty arrays when none. Regenerate/version all adapters through the connector version workflow.                                                |
| Runner           | No behavioral change. It only launches agents.                                                                                                                                                                                                        |
| REST             | Add delivery DTO projection and read endpoint; expose `deliveryId` on delivery events; emit/read realtime delivery changes; never return raw provider/debug data.                                                                                     |
| Automations      | Add a provider-contained `compose-delivery` automation, schema-constrained Gemini call, sanitizer, and deterministic fallback contract. No database access.                                                                                           |
| Web SPA          | Add delivery query, click-through drawer/card, colored sections, fallback/pending states, and realtime invalidation for `entity_type = delivery`.                                                                                                     |
| Desktop          | No desktop-specific logic. It receives the SPA behavior through the existing Desktop-to-REST surface.                                                                                                                                                 |
| MCP              | Extend `overlord_deliver_session` input/output schemas and handler mapping so hosted agents can submit the same evidence and artifacts. Keep new fields optional.                                                                                     |
| Auth/RBAC        | No new permissions. Delivery reads continue under `mission:read`; protocol writes use existing lifecycle permissions.                                                                                                                                 |
| Webhooks         | Add the normalized report to full `mission.delivered` envelopes. Thin envelopes remain unchanged.                                                                                                                                                     |
| Extension system | No new extension point or connector capability is needed. Custom automations remain supported through the existing registration seam.                                                                                                                 |




## Implementation Plan



### Phase 0: Contract and fixtures

1. Update contract version/changelog and component declarations.
2. Specify `DeliveryReportPayloadV1` and the protocol envelope.
3. Update protocol CLI/MCP schemas and REST/database documentation.
4. Add JSON fixtures for:
  - a complete agent report
  - empty arrays
  - a legacy summary-only delivery
  - prohibited git/QA actions
  - malformed/oversized model output
5. Add shared human-action policy tests before wiring callers.

Exit condition: all affected components agree on field names, defaults, limits,
and fallback semantics.

### Phase 1: Protocol evidence and deterministic presentation

1. Add shared contract types and runtime validation.
2. Correct delivery envelope parsing in CLI and backend protocol dispatch.
3. Extend hosted MCP parity.
4. Update connector core instructions and generated adapters.
5. Store normalized agent evidence and deterministic presentation in
  `deliveries.payload_json`.
6. Keep old flag combinations and summary-only deliveries working.
7. Add protocol/service tests for persistence, filtering, size limits, and
  non-blocking empty/missing evidence.

Exit condition: new agents can report tradeoffs/actions and delivery remains
instant even with no Gemini key.

### Phase 2: Delivery read API and UI

1. Implement `DeliveryDto` projection and mission deliveries endpoint.
2. Include `deliveryId` in delivery event DTOs.
3. Fix `ovld mission deliveries` to use the deliveries endpoint.
4. Add query keys and realtime invalidation for delivery changes.
5. Add click-to-expand delivery details to `LiveActivityFeed`.
6. Render blue human-action and amber tradeoff sections.
7. Add component and accessibility tests in light/dark modes.

Exit condition: the user can click a delivery event and see structured facts
without any AI enrichment.

### Phase 3: Asynchronous Gemini composition

1. Add the built-in `compose-delivery` automation.
2. Add transactional job enqueueing to `deliverSession()` and `recordWork()`.
3. Implement the leased/retrying delivery composition worker.
4. Build bounded context and deterministic candidate actions.
5. Add schema-constrained Gemini generation, sanitization, source reconciliation,
  and persistence.
6. Emit `entity_changes` for successful/fallback report updates.
7. Add fake-provider tests for success, timeout, invalid JSON, hallucinated
  items, duplicate jobs, server restart, and stale lock recovery.

Exit condition: Gemini improves presentation asynchronously and can never alter
delivery success.

### Phase 4: Parity, observability, and rollout

1. Include normalized reports in full webhook envelopes.
2. Update CLI, MCP, connector, REST, UI, and public docs together.
3. Add metrics/logs for queued, composed, fallback, failed, duration, model, and
  bounded token/input size. Do not log prompt content.
4. Add an admin/manual "Regenerate delivery message" action only if operational
  experience shows it is needed.
5. Optionally enqueue backfill jobs for recent legacy deliveries; otherwise rely
  on read-time deterministic projections.
6. Run contract conformance, protocol lifecycle, database adapter, backend,
  MCP-schema, connector, and webapp suites.

Exit condition: Local and Cloud editions have equivalent behavior and every agent
surface can submit the evidence schema.

## Test Matrix


| Scenario                               | Expected result                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Gemini key absent                      | Delivery succeeds; deterministic report is immediately visible.                  |
| Gemini timeout/error                   | Delivery already succeeded; fallback remains visible; job retries within bounds. |
| Agent omits new fields                 | Delivery succeeds; fields normalize to empty arrays.                             |
| Agent reports no actions/tradeoffs     | Empty sections are hidden.                                                       |
| Agent reports `git push` as an action  | Entry is filtered and never shown.                                               |
| Agent reports "review/test the code"   | Entry is filtered and never shown.                                               |
| Gemini invents an unsupported action   | Entry is dropped during source reconciliation.                                   |
| Gemini invents an unsupported tradeoff | Entry is dropped during source reconciliation.                                   |
| Duplicate worker execution             | Same delivery report is updated idempotently; no duplicate events/cards.         |
| Legacy delivery                        | API synthesizes a deterministic V1 report without mutating history.              |
| Follow-up redelivery                   | Each delivery has its own report and history; prior delivery is unchanged.       |
| Local SQLite restart mid-job           | Lock expires and job resumes; original delivery remains readable.                |
| Concurrent report update               | Revision/CAS prevents stale worker output from overwriting newer output.         |
| Full webhook subscription              | Normalized report is included; raw payload/debug metadata is not.                |
| Thin webhook subscription              | Existing ID/link-only behavior is unchanged.                                     |




## Acceptance Criteria

- Delivery latency and success do not depend on Gemini.
- Existing clients and summary-only delivery calls continue to work.
- New agents are instructed to report human actions and tradeoffs, with empty
arrays when none exist.
- Human actions never include git operations or routine review/testing.
- Tradeoffs and actions remain traceable to agent/rationale/rule evidence.
- Clicking a delivery event shows Markdown plus blue action and amber tradeoff
sections.
- Empty sections are hidden and fallback content is always useful.
- Each delivery/redelivery preserves its own original summary and structured
report.
- Local and Cloud use the same protocol, REST DTO, database job, and UI behavior.
- CLI, MCP, connector instructions, webhooks, and public docs ship in parity.



## Decisions and Non-Goals

Decisions:

- Prefer hybrid evidence-plus-composition over agent-only or Gemini-only output.
- Never block delivery on the new evidence fields or on model availability.
- Keep original agent summary immutable; store AI presentation separately.
- Use a durable background job rather than request-bound `void` work.
- Reuse `deliveries.payload_json`; avoid new delivery columns.

Non-goals for the first release:

- replacing change rationales with AI summaries
- sending raw diffs to Gemini
- automatically executing human actions
- adding git actions to the action list
- adding a new mission-event type
- building a separate feed-post table
- requiring a backfill of all historical deliveries

