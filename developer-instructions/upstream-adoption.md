# Adopting Upstream Changes in Customized Instances

This guide describes the recommended workflow for running one or more customized
OpenOverlord instances while still adopting upstream changes from the public
OpenOverlord repository.

The short version: keep each customization behind a contract-sanctioned boundary,
then treat every upstream update as a contract conformance exercise before it
reaches a production instance.

## Submodule vs Downstream Distribution

Do **not** make a Git submodule the default way to run a customized
OpenOverlord instance if you expect to edit core OpenOverlord code directly. A
submodule is good for pinning a mostly unchanged upstream dependency inside a
larger deployment repository, but it is awkward for day-to-day core work:

- every core change must be committed inside the nested repository and then the
  parent repository must also update its submodule pointer;
- local core patches are easy to hide in the submodule worktree and miss during
  parent reviews;
- cross-cutting changes between core code, mobile apps, deployment automation,
  and instance configuration are split across repositories and histories;
- adopting upstream still becomes a merge/rebase problem, just with an extra
  parent pointer to maintain.

Prefer a downstream distribution repository or fork that keeps upstream
OpenOverlord as a normal Git remote. In the closed downstream fork, `origin`
points at the private distribution repository and `upstream` points at public
OpenOverlord:

```bash
git remote add upstream https://github.com/cooperativ-labs/OpenOverlord
git fetch upstream
git branch --track upstream-main upstream/main
git checkout -b distribution upstream/main
```

Then add instance-specific packages and deployment assets beside the core repo
in that distribution branch, for example `apps/mobile`, `deploy/`,
`automations/custom-*`, or `extensions/<name>`. Keep direct changes to
upstream-owned modules small, reviewable, and either upstream-bound or
documented as carried core patches.

Use a submodule only when the parent repository is primarily an external
orchestrator: for example, a private infrastructure repo that pins a released
OpenOverlord commit and stores Terraform, secrets wiring, or environment
templates, while all OpenOverlord product code changes still happen in a fork or
branch of the OpenOverlord repository itself.

## Operating Model

Run customized OpenOverlord as a downstream distribution of upstream
OpenOverlord, not as an unrelated fork. The downstream repository should carry
only three categories of change:

| Lane | What belongs here | Upstream adoption risk |
| --- | --- | --- |
| Instance configuration | `overlord.toml`, environment settings, deployment manifests, device routing, secrets wiring | Low, because it should not alter product code or contracts |
| Contracted extensions | `ext_<name>_` database migrations, namespaced metadata, custom connectors, auth providers, REST extensions, conformance manifests | Medium, bounded by the declared extension points |
| Core patches | Direct changes to upstream-owned modules or stable interfaces | High, should be rare and either upstreamed or converted into a contracted extension |

If a customization cannot fit one of the sanctioned extension points in
[`CONTRACT.md`](../CONTRACT.md), do not merge it as a silent local patch. Propose
the contract change first, list the impact on the affected modules, and only then
implement the downstream behavior.

## Repository Layout

Use Git history to make the boundary between upstream and local behavior obvious:

1. Keep `upstream-main` tracking `upstream/main` exactly. Do not commit
   downstream work there; update it only by fetching from the public upstream.
2. Keep a long-lived `distribution` branch created from `upstream/main`. This is
   the closed integration branch that carries downstream-approved changes.
3. Put each substantial Overlord Lite customization on a short-lived
   `lite/<topic>` branch created from `distribution`, then merge it back into
   `distribution` after review and verification.
4. Use `adopt/upstream-<date>` branches for upstream adoption cycles. Create
   them from `distribution`, merge or rebase `upstream/main`, resolve conflicts,
   run conformance and module checks, then merge the result back to
   `distribution`.
5. Keep per-instance deployment state outside the code branch when possible:
   environment variables, secret stores, database files, and local
   `overlord.toml` overlays should not be required to merge upstream code.

For multiple instances, build one tested distribution artifact per upstream
adoption cycle, then apply instance-specific configuration during deployment.
Avoid letting each instance drift into its own code fork unless there is a clear,
documented reason.

## Upstream Adoption Loop

Use this loop for every upstream update, whether it is a release tag or a commit
range.

### 1. Freeze the Current Baseline

Before pulling upstream, record:

- the current upstream commit or release tag;
- the downstream distribution commit;
- the contract version in `CONTRACT.md` and `contract/components.yaml`;
- the set of downstream conformance manifests;
- the currently applied core and extension database migrations;
- the production configuration version for each instance.

This gives you a rollback point and a clear diff target.

### 2. Fetch and Review Upstream

Fetch upstream into a temporary integration branch:

```bash
git fetch upstream
git checkout -b adopt/upstream-<date> distribution
git merge upstream/main
```

Keep the local mirror branch current as part of the same adoption cycle:

```bash
git checkout upstream-main
git merge --ff-only upstream/main
git checkout distribution
```

Review upstream changes in this order:

1. Contract files: `CONTRACT.md` and `contract/*.yaml`.
2. Database schema and migrations.
3. Protocol, CLI, runner, REST, auth, connector, and extension surfaces.
4. Module implementation changes.
5. Documentation and tests.

The contract review determines the rest of the work. A normal implementation
change that preserves the contract can be merged and tested. A contract version
change requires each downstream customization to prove compatibility with the new
contract before rollout.

### 3. Classify Local Conflicts

For every merge conflict or failing test, classify the local code as one of:

- **Configuration:** move it out of source if possible.
- **Contracted extension:** keep it, but update its conformance manifest and
  tests for the new upstream contract.
- **Core patch:** decide whether to upstream it, replace it with an extension
  point, or carry it intentionally with a written rationale.

Do not resolve conflicts by editing upstream internals directly from an extension
unless the contract explicitly allows that interaction surface.

### 4. Run Contract and Module Verification

At minimum, run the checks that prove the downstream distribution still respects
the upstream contract:

```bash
ovld contract check <path-to-conformance-manifest.yaml>
```

Run that check for every shipped connector, extension, database adapter, auth
provider, and REST module that your distribution adds or modifies. Then run the
module test suites affected by the upstream diff and every downstream
customization touched by the merge.

For database changes, test migration behavior in both directions that your
operations policy supports:

- new upstream core migrations applied before extension migrations;
- extension migrations still using the `ext_<name>_` table namespace;
- no extension writing directly to core tables outside service APIs;
- a restored production-like database can migrate on a staging copy.

### 5. Upgrade Staging Instances First

Apply the integrated build to a staging instance that resembles production:

1. Restore or clone a production-like database.
2. Apply upstream migrations.
3. Apply extension migrations.
4. Start the service and run smoke tests through the CLI, protocol, REST, auth,
   connector, and runner paths that the instance uses.
5. Verify customized behavior through public surfaces rather than internal table
   edits or private module calls.

For multiple production instances, run at least one staging validation for each
meaningfully different customization set.

### 6. Roll Out With an Instance Matrix

Track each instance against the same adoption matrix:

| Instance | Current distribution | Target distribution | Contract version | Extension set | Migration state | Status |
| --- | --- | --- | --- | --- | --- | --- |
| production-a | `<commit>` | `<commit>` | `0` | `<list>` | `<version>` | pending |

Roll out in small batches. After each batch, verify protocol attach/update/deliver
flows, runner queue processing, auth identity resolution, and any custom
connector or extension behavior.

## Handling Contract Changes

The contract is the compatibility boundary. Use this policy:

- **Same contract version:** merge upstream, run conformance and module tests, and
  roll out normally.
- **Additive draft contract change:** update downstream manifests and tests; roll
  out only after every affected customization declares support for the new
  version.
- **Breaking contract change:** create a migration plan for each affected
  customization before adopting the upstream change. Do not run mixed contract
  assumptions in one instance.
- **Downstream needs a new surface:** propose and document the contract change
  before implementing it. If it is instance-specific, prefer a namespaced
  extension point over changing core behavior.

## Customization Rules

Follow these rules to keep future upstream adoption cheap:

- Prefer extensions, providers, connectors, and configuration over core patches.
- Give every shipped customization a conformance manifest when the contract
  requires one.
- Keep extension database objects under `ext_<name>_`.
- Store custom metadata under namespaced keys.
- Use service APIs, protocol commands, REST endpoints, and connector hooks rather
  than direct cross-module imports or table writes.
- Keep local patches small enough that each can be upstreamed, deleted, or
  explained during the next adoption cycle.
- Document every carried core patch with owner, reason, affected contract
  component, and exit strategy.

## Recommended Cadence

Adopt upstream on a predictable cadence instead of waiting until a critical fix
forces a large merge:

- pull upstream at least weekly for active instances;
- adopt security fixes immediately through the same staged loop;
- keep an integration branch green continuously if the distribution has many
  customizations;
- schedule contract-version upgrades as explicit work, not incidental merge
  cleanup.

This keeps local customization pressure visible and makes it clear when a
downstream need should become an upstream contract extension.
