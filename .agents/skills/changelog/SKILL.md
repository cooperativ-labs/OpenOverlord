---
Name: changelog
Description: use this skill to generate and update the project changelog from recent changes.
allowed-tools: Read, Edit, Write, Grep, Glob
user-invocable: true
---

# changelog

## Instructions

### What this skill does

- Generates or updates `CHANGELOG.md` entries for a **new version** or for the **current unreleased work**.
- Ensures the changelog stays consistent with this repository’s conventions and remains the **single source of truth** for notable changes.

### When to use this skill

- When preparing a **release** (version bump in `package.json` or other release artifact).
- When a **significant feature, refactor, or security fix** lands and should be documented.
- When the user explicitly asks to **update the changelog** or **summarize recent changes**.

### General rules

- **Never edit `CHANGELOG.md` directly** outside of this skill’s instructions.
- **Always read the latest `CHANGELOG.md`** before making changes so you understand the existing structure and most recent version.
- New entries use the **project version string** in brackets and a **UTC** timestamp after the colon.
- **Current version format** (workspace and CLI): `major.yymmddhhmm.x` — three dot-separated parts where the middle segment is ten digits `yymmddhhmm` in **UTC**. Example heading: `## [0.2605101237.0] - 2026-05-10:12:37` (decode `2605101237` → 2026-05-10 12:37 UTC; the heading date/time should match that middle segment).
- **Legacy entries** in `CHANGELOG.md` may still show historical semver-style tags (for example `## [5.19.0] - 2026-05-10:11:57`); do not rewrite old headings when adding new releases.
- Use clear, user-facing language that describes **what changed and why it matters**, not low-level implementation details.
- Prefer present/imperative phrasing in bullets (e.g. `Add agent waiting-response notifications` instead of `Added…`), unless matching an established style in the file.

## Sections and structure

Every changelog update must include all of the following section headings, in this order, even if some sections have no entries:

- `### Added`
- `### Fixed`
- `### Changed`
- `### Security`

Only include the following sections if they have changes:

- `### Removed`
- `### Deprecated`
- `### Performance`
- `### Refactor`
- `### Test`
- `### Documentation`
- `### Chore`

If a section has no changes for a given version, include a single bullet `- None.` under that heading.

New versions should be appended **below** the top-of-file description and **above** older versions, so the newest version appears closest to the top (as in existing entries in the file).

## Mapping changes to sections

When you are turning recent work into a changelog entry:

- **Added**: New features, capabilities, or APIs exposed to users (e.g. new Kanban notifications, new project status management UI).
- **Fixed**: Bug fixes and correctness improvements that resolve incorrect behavior.
- **Changed**: Behavioral changes or UX changes that are not strictly new features, such as data loading adjustments or UI layout updates.
- **Security**: Any change that improves security, hardens the app, or fixes vulnerabilities (e.g. CSP header updates in Electron).
- **Removed**: Features or APIs that have been removed or retired.
- **Deprecated**: Features or APIs that are still present but are now discouraged and scheduled for removal.
- **Performance**: Changes that significantly improve responsiveness, memory, bundle size, or efficiency.
- **Refactor**: Internal structural changes that don’t alter external behavior but improve code quality or maintainability.
- **Test**: New or updated tests, test infrastructure, or coverage improvements.
- **Documentation**: Changes to docs, comments that carry important behavioral meaning, guides, or READMEs.
- **Chore**: Tooling, dependency bumps, internal maintenance, and non-user-facing tasks.

If you are using a conventional commit style, you can map types to sections:

- `feat:` → usually `### Added` (or `### Changed` if it primarily alters existing behavior).
- `fix:` → `### Fixed`.
- `perf:` → `### Performance`.
- `refactor:` → `### Refactor`.
- `test:` → `### Test`.
- `docs:` → `### Documentation`.
- `chore:` → `### Chore`.
- `security:` or `sec:` → `### Security`.

## Step-by-step procedure

1. **Read the current changelog**
   - Use `Read` on `CHANGELOG.md`.
   - Identify the most recent version heading and review its structure.

2. **Determine the target version**
   - If the user provides an explicit version, use that.
   - Otherwise, read `package.json` and use its `version` field as the version number for the new entry.
   - For the heading suffix after the colon, use **UTC** in `YYYY-MM-DD:hh:mm` format. If the version matches `major.yymmddhhmm.x` (middle segment exactly ten digits), derive that timestamp from the middle segment so it matches the encoded release time; otherwise use the current UTC date and time.

3. **Gather changes to document**
   - Use git history, pull request descriptions, and recent edits in the workspace to understand what changed since the last documented version.
   - Focus on **user-visible** behavior: new capabilities, UI updates, bug fixes, security improvements, and performance changes.

4. **Assign each change to a section**
   - For each notable change, decide which of the required headings it belongs under using the mapping above.
   - If a change touches multiple concerns (for example performance and refactor), place it under the section that best represents its user-visible impact (usually `Added`, `Changed`, or `Performance`).

5. **Write concise bullets**
   - Use short, clear sentences or sentence fragments.
   - Avoid implementation detail (e.g. specific variable names) unless it directly affects users.
   - Group related bullets by feature area when useful (e.g. Tickets, Projects, Electron, CLI).

6. **Update `CHANGELOG.md`**
   - Insert a new version block at the appropriate location (just above the previous version’s heading).
   - Ensure all required headings are present for the new version, with `- None.` under any heading without changes.
   - Preserve existing content and formatting.

7. **Verify**
   - Re-read the full changelog around the new entry to ensure dates, version numbers, and headings are correct.
   - Confirm that the new entry matches the style of recent entries in the file (required sections, bullets, optional sections only when needed).

## Examples

### Example: adding a new version

Assume the current `CHANGELOG.md` begins like this:

```markdown
## [0.6.0] - 2026-02-24:12:44

### Added
- Agent waiting-response notifications on the Kanban board.

### Changed
- Ticket board data loading now includes the active agent identifier.
```

You want to add a new release `0.7.0` on `2026-02-24` that introduces a new analytics dashboard, fixes a Kanban drag-and-drop bug, and adds a performance optimization. The updated top of the file should look like:

```markdown

## [0.7.0] - 2026-02-24:12:44

### Added (Always include this section)
- New analytics dashboard for ticket throughput and agent load.

### Fixed (Always include this section)
- Resolve occasional Kanban drag-and-drop failures when rapidly reordering tickets.

### Changed (Always include this section)
- None.

### Security (Always include this section)
- None.

### Removed (IF ANY)
- None.

### Deprecated (IF ANY)
- None.

### Performance (IF ANY)
- Improve Kanban board rendering performance for large projects.

### Refactor (IF ANY)
- None.

### Test (IF ANY)
- None.

### Documentation (IF ANY)
- None.

### Chore (IF ANY)
- None.

## [0.6.0] - 2026-02-24:10:44
```

Use this pattern for all future changelog updates so that the file remains consistent and easy to scan.

<!-- version: 1.2.0 -->