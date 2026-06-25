# Planning & Feature Plans — Index

This directory holds feature plans, proposals, and recommendations: **work that
is not-yet-built or under discussion**. Once a proposal ships, its behavior moves
into the owning module's colocated specs (`<module>/docs/`), and this index is
the **redirect** that points each plan at the module / topic it belongs to.

> Where to put a new doc: a *plan or proposal* for unbuilt work lives here.
> *How a shipped feature behaves* lives in the owning module's `docs/`. See the
> documentation taxonomy in the [docs map](../../docs/README.md#where-docs-live).

## Plans by topic

### CLI · Protocol · Delivery
| Plan | What it proposes |
| --- | --- |
| [Reducing Agent Delivery Friction](agent-delivery-friction.md) | Lowering the cost of the agent `deliver` step (coo:18). |
| [Optimizing the Deliver Step](deliver-step-efficiency.md) | Efficiency improvements to deliver (coo:17). |
| [Post-Delivery Follow-Up Reactivation](post-delivery-follow-up-reactivation.md) | Reattaching to a delivered mission for follow-up execution. |
| → Owning module: [`cli/`](../../cli/README.md) (`cli`, `protocol` components) |

### Runner · Launch & Execution
| Plan | What it proposes |
| --- | --- |
| [Objective Launch and Execution Flow Review](objective-launch-execution-flow-review.md) | Review of the launch → execution-request → runner flow. |
| [Runner Background Daemon](runner-background-daemon.md) | Run the poller without occupying a terminal. |
| [Global Foreground Runner](runner-global-foreground.md) | One terminal serving all accessible projects. |
| → Owning module: [`cli/`](../../cli/README.md) (`runner` component) |

### Webapp · Branching
| Plan | What it proposes |
| --- | --- |
| ["My Missions" Selected-Workspace View](my-missions-cross-workspace-view.md) | Cross-workspace mission view in the web app. |
| [Branch Actions — Create PR & Merge](branching/branch-actions-pr-merge.md) | "Create PR" / "Merge with parent" branch actions. |
| [Worktree & Branch Automation](branching/worktree-branch-automation.md) | Worktree and branch automation implementation plan. |
| → Owning module: [`webapp/`](../../webapp/README.md) (`rest` component) |

### Database · Deployment
| Plan | What it proposes |
| --- | --- |
| [Railway + PostgreSQL Deployment](railway-postgres-deployment-recommendation.md) | Hosted Postgres deployment recommendation. |
| [Remote Overlord Architecture Recommendations](remote-overlord-architecture-recommendations.md) | Architecture options for a remote/hosted Overlord. |
| → Owning module: [`database/`](../../database/README.md) |

### Desktop · Packaging
| Plan | What it proposes |
| --- | --- |
| [Desktop App Module — Integration Plan](desktop-app-module.md) | Integrating the Electron desktop shell. |
| [Desktop App Packaging](desktop-app-packaging.md) | SQLite distribution and signed macOS builds. |
| [Native Node Modules Isolation](native-node-modules-isolation.md) | Isolating native modules across platforms in the build. |
| → Owning module: [`desktop/`](../../desktop/README.md) |

### Repo Structure & Developer Ergonomics
| Plan | What it proposes |
| --- | --- |
| [Developer Ergonomics for the Modular Repo](developer-ergonomics-proposal.md) | Workspace conversion and module ergonomics (Phases 0–2 delivered). |
| [Repo Structure & Documentation Reorganization](repo-structure-and-docs-reorg.md) | The `apps/`/`packages/` question and the docs reorg (this mission, coo:24). |
| → Affects the whole repo; see the [docs map](../../docs/README.md). |
