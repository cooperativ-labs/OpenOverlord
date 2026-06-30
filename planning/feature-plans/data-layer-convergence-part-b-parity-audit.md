# Part B phase 1 — DTO parity audit (coo:61 item 6, §2.2)

Companion to `data-layer-convergence-and-sync-handle-retirement.md`. This is the
plan's **phase 1: DTO parity audit (no code change)** — a field-by-field diff of the
two layers' five overlapping reads, run to decide the safe delegation order.

Layers compared (note the post-plan relocation — the REST layer moved from
`webapp/server/repository.ts` to `backend/repository.ts` in commit c6ecb5ee):

- **REST** — `backend/repository.ts`, consumed by web/desktop. Returns the rich
  `*Dto` shapes from `packages/contract/src/index.ts`.
- **Core service** — `packages/core/service/missions.ts`, consumed by the
  protocol/CLI. Returns the lean `*Summary` shapes defined in that file.

## Per-read parity table

| Read | Core `*Summary` | REST `*Dto` | Ordering | Verdict |
|---|---|---|---|---|
| `listMissions` | 10 fields | 22 fields | core: `updated_at DESC`; REST: `board_position ASC, sequence_number DESC` | **REST super-set; different order & signature** |
| `searchMissions` | 10 fields | 22 fields | identical FTS bm25 scoring + per-mission aggregate in **both** | **Same ranking logic duplicated; DTO differs** |
| `listObjectives` | 8 fields (`objective`) | 16 fields (`instructionText` + agent/model/branch/session joins) | both `position ASC` | **REST super-set; field rename** |
| `listMissionEvents` | 6 fields, limit 100 | 11 fields (+actor join, source, externalUrl), limit 200 | core: `created_at ASC`; REST: `created_at DESC` | **REST super-set; opposite order** |
| `listArtifacts` | 5 fields (`content`), no limit | 14 fields (`contentText`+`contentJson`), limit 200 | core: `created_at ASC`; REST: `created_at DESC` | **REST super-set; opposite order; field rename** |

### Field-level notes

- **`MissionSummary` ⊂ `MissionDto`.** REST adds `workspaceId`, `sequenceNumber`,
  `boardPosition`, `assignedWorkspaceUserId`, `acceptanceCriteria`, `availableTools`,
  `revision`, four read-side aggregates (`completedObjectiveCount`,
  `hasExecutingObjective`, `hasCompletedObjective`,
  `hasPendingObjectiveWithInstructions`), `tags` (a joined `getTagsByMission`), and
  branch metadata in the row. Core omits all of these. **Signatures differ too:**
  core `listMissions` takes `{projectId?, statusTypes?, limit}`; REST takes only
  `projectId` and orders by board position.
- **`ObjectiveSummary` vs `ObjectiveDto`.** Same core columns, but REST renames
  `objective`→`instructionText` and joins `agent_sessions` for `externalSessionId`
  and `branch`, plus `assignedAgent`/`model`/`reasoningEffort`/`revision`.
- **`MissionEventSummary` vs `MissionEventDto`.** REST joins `workspace_users`+
  `profiles` to build an `actor` object, adds `source`/`externalUrl`/`missionId`,
  and lists **newest-first** (core lists oldest-first). Default limits differ
  (200 vs 100).
- **`ArtifactSummary` vs `ArtifactDto`.** REST renames `content`→`contentText`, adds
  a parsed `contentJson`, the full ownership chain
  (`workspaceId`/`projectId`/`sessionId`/`deliveryId`), timestamps, lists
  newest-first (core oldest-first), and caps at 200.

## Headline finding — the plan's safety property does not hold as written

The plan's phase-2 acceptance test is *"the REST JSON is unchanged before and after"*
delegation, justified by *"No DTO shape changes … the change is purely which layer
owns the implementation."* **That premise is false against the current code.** For
every one of the five reads the REST DTO is a **strict super-set** of the core
summary, and three of the five additionally **sort in the opposite direction** and
use different default limits. There is no way for a REST handler to "delegate to the
core service and return a byte-identical DTO" because the core service returns fewer
fields, in a different order.

The two shapes are not accidental drift — they are **two deliberate contracts for two
consumers**: terse summaries for the protocol/CLI, rich DTOs for the web/desktop UI.
Converging them to one DTO would change one surface's wire format (either bloating the
CLI/protocol payload or dropping fields the web client reads).

## What is actually safe to converge

Only **logic** that is genuinely duplicated and produces identical output regardless of
DTO shape:

1. **`searchMissions` FTS ranking (the one true duplication).** `buildFtsMatch`
   (core) and `buildMissionSearchMatch` (REST) are byte-identical token builders; the
   bm25 column-weight + entity-kind scoring expression and the
   accumulate-per-mission-then-rank loop are copy-pasted in both files. If someone
   tunes the weights in one place, the two surfaces silently rank differently — this is
   the exact drift the mission targets. Extracting the match-builder, the scoring SQL
   fragment, and the ranking comparator into a shared core helper that **both** layers
   import (backend already imports from `../packages/core/service/*`) eliminates the
   drift **without changing either DTO's wire output**. Verifiable with the existing
   `missions.search.test.ts` plus a backend search test.

The SELECT column lists, the row→DTO mappers, the ordering, the limits, and the
enrichment joins are **not** safely shareable — they differ by contract on purpose.

## Recommendation (supersedes the plan's phases 2–4)

- **Do:** the shared-search-helper extraction above (safe, verifiable, kills the real
  drift risk), and a `CONTRACT.md` note that the mission-search **ranking algorithm**
  (not the DTO) is owned by the core service and re-used by REST.
- **Don't:** force the remaining four reads through a single core implementation. That
  would require either (a) expanding the core summaries into super-sets with
  parameterized ordering/limit — a breaking change to the protocol/CLI wire contract —
  or (b) a core layer that returns rich rows the REST layer trims and the CLI re-trims,
  which adds indirection without removing the two distinct mappers. Both are net-worse
  than the documented status quo. Instead, **document the ownership split** in
  `CONTRACT.md`: the REST and protocol read DTOs are intentionally distinct contracts,
  and the only shared, single-owner element is the search-ranking algorithm.

This is a smaller, safer landing than the plan envisioned, because the audit it
mandated revealed the premise (byte-identical delegation) was not achievable. The
convergence that *is* real — the FTS scoring — is the highest-value piece anyway.
