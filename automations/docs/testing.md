# Automations Module — Test Plan

Part of the [master test plan](../../TEST_PLAN.md). Covers the `automations` contract
component. Normative source: [`01-automations-overview.md`](01-automations-overview.md) and the
`serviceToAutomations` surface in [`contract/components.yaml`](../../contract/components.yaml).

Current code under test: `src/automations/`.

---

## A. Title helpers (`src/automations/title-summarizer/helpers`) — L1 unit

### A1. Local derivation
- Short instruction text returns unchanged.
- Text longer than 100 characters truncates with an ellipsis.

---

## B. Objective title automation (`src/automations/title-summarizer/objectives`) — L1 unit

### B1. Threshold behavior
- Instruction text at or below `AI_TITLE_THRESHOLD` never requires Gemini.
- Long text with no API key falls back to local derivation.
- `aiTitleGenerationEnabled: false` skips Gemini even when a key is present.

### B2. Persistence callback
- `generateAndSetObjectiveTitle` calls `ObjectiveTitleStore.updateObjectiveTitle` with the resolved title.
- Blank instruction text does not invoke the store.

---

## C. Registry (`src/automations/registry`) — L1 unit

### C1. Built-in catalog
- `listAutomations` exposes `summarize-text` and `summarize-objective-title`.
- `getAutomation` resolves by id.

### C2. Registration guard
- `registerAutomation` rejects duplicate ids.

---

## D. Provider integration — deferred L2

Gemini network calls are not exercised in unit tests. Future integration tests may
mock `generateGeminiText` or run behind an opt-in `AUTOMATIONS_LIVE=1` gate once a
service-layer objective attach flow exists.
