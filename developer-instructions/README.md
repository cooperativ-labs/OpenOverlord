# Overlord Documentation Map

The front door to **all** of Overlord's documentation. The repo has several
documentation surfaces that live in different places by design (specs colocate
with the module that owns them); this page ties them together so you can find
the right one without spelunking.

New to Overlord? Start with the [Getting Started guide](getting-started.md).
Want to know how the system works internally? Read the
[architecture series in order](architecture.md).

## The seven documentation surfaces

### 1. Root narrative docs

The whole-repo entry points, at the repository root:

- [`README.md`](../README.md) — what Overlord is, core concepts, and the module
  table of contents (human-facing front door).
- [`CONTRACT.md`](../CONTRACT.md) — the **normative spec** for how modules
  interact. Read it before any change that crosses a module boundary.
- [`TEST_PLAN.md`](../TEST_PLAN.md) — the five-layer test strategy and the
  cross-module contract conformance suite.
- [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) — agent-facing
  working instructions for this repo.

### 2. User guides

Install, set up, and operate an Overlord instance — in [`docs/`](.):

- [Getting Started](getting-started.md) — fresh `ovld` install to first
  delivered mission in ~10 minutes.
- [Setting Up a Custom Instance](custom-instance-setup.md) — the ordered
  interview for standing up your own instance.
- [Downstream Fork Agent Setup](downstream-fork-agent-setup.md) — configuring
  agents in a downstream fork.
- [Adopting Upstream Changes](upstream-adoption.md) — the contract-first
  workflow for pulling upstream changes into a customized instance.
- [Mission Data Webhooks](webhooks.md) — send signed HTTP deliveries to
  independent software on mission events (delivery, status change, blocked),
  with a pull path over the REST API for anything the payload omits.

### 3. Architecture series (how the system works, in order)

The cross-module `NN-*.md` behavior specs, read as one narrative:

- **[Architecture — Reading Order](architecture.md)** — the ordered index over
  the whole series. Files stay colocated under each `<module>/docs/`.

### 4. Module behavior specs & per-module docs

Each workspace owns its detailed specs and test plan under `<module>/docs/`:

- [packages/core/](../packages/core/README.md) · [database/](../database/README.md) · [cli/](../cli/README.md) ·
  [auth/](../auth/README.md) · [webapp/](../webapp/README.md) ·
  [connectors/](../connectors/README.md) · [automations/](../automations/README.md) ·
  [desktop/](../desktop/README.md) · [contract/](../contract/README.md)
- **Web UI design set:** [`webapp/docs/ui/`](../webapp/docs/ui/README.md) — the
  well-ordered `00…10` UI specification (the model the rest of the docs follow).

### 5. Planning & proposals

Not-yet-built or under-discussion work lives in
[`planning/feature-plans/`](../planning/feature-plans/).

### 6. Security audits

Dated external-surface reviews in
[`security-audits/`](../security-audits/) (one Markdown report per audit date).

### 7. Agent history

Per-mission investigation notes in [`ai/history/`](../ai/history/).

## Where docs live

So new documentation lands in the right place by default, every surface has a
home and a rule:

| Surface | Holds | Lives in |
| --- | --- | --- |
| User guides | install / setup / operate Overlord | [`docs/`](.) |
| Architecture series | how the system works, in order | `<module>/docs/NN-*.md` (indexed by [`docs/architecture.md`](architecture.md)) |
| Module behavior specs | per-module detail + `testing.md` | `<module>/docs/` |
| Web UI design set | the ideal web control center, screen by screen | [`webapp/docs/ui/`](../webapp/docs/ui/README.md) |
| Planning / proposals | not-yet-built or under-discussion work | [`planning/feature-plans/`](../planning/feature-plans/) |
| Security audits | dated external-surface reviews | [`security-audits/`](../security-audits/) |
| Agent history | per-mission investigation notes | [`ai/history/`](../ai/history/) |
| Normative spec | the contract | [`CONTRACT.md`](../CONTRACT.md) + [`contract/`](../contract/) |
