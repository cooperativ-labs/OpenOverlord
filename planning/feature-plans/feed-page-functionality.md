# Feed Page Functionality

The `/feed` page is the activity feed for AI-assisted work in Overlord. It is designed to answer a practical question for a user or reviewer: what did agents recently do across my projects, what changed, what tradeoffs matter, and what do I need to act on?

Feed posts are not written manually by users. They are generated from ticket activity after agent work reaches a review or completion point, then shown as a scannable timeline.

## What The Feed Is For

Use the feed to review completed agent work across projects without opening every ticket one by one.

The page is useful for:

- Seeing recently delivered work across all projects.
- Filtering the timeline to one project.
- Finding tickets that are currently in execution.
- Reading concise summaries of completed agent sessions.
- Spotting human follow-up actions, such as running a migration, adding an environment variable, deploying a function, or configuring an external service.
- Reviewing tradeoffs and implementation decisions that might affect product, deployment, or code review.
- Jumping from a feed item back to the underlying ticket.
- Opening touched files in the configured local editor when a project has a linked working directory.

The feed should be treated as a high-signal review surface, not as the canonical source of truth. The canonical record remains the ticket: objectives, updates, questions, artifacts, deliveries, and change rationales all live there. The feed summarizes that record so users can scan work quickly.

## Page Structure

The web route is implemented at `apps/web/app/(app)/feed/page.tsx`.

On initial load, the page fetches:

- the current user's projects
- the user's preferred editor scheme
- tickets currently in an execute status

It passes those values into `FeedList`, which renders the main feed UI.

The page has two main sections:

1. **In execution**: tickets currently being worked by an agent.
2. **Completed**: generated feed posts for delivered or completed work.

A project filter in the top-right lets the user switch between all projects and a single project.

## In-Execution Tickets

The "In execution" section is not a feed post list. It is a live status surface for tickets that are currently in an execute-type status and have an attached or executing agent.

The data comes from `getExecutingFeedTicketsAction` in `lib/actions/feed.ts`.

That action:

- finds execute-type ticket statuses for the user's organizations
- fetches recent tickets in those statuses
- joins project name and color
- checks recent agent sessions and executing objectives
- returns tickets with a running agent identifier

The client keeps this section fresh with `useExecutingFeedTickets`, which invalidates the query when relevant `tickets`, `agent_sessions`, or `objectives` rows change through Supabase Realtime. It also refetches periodically.

Use this section to see what is active now. Once an agent delivers work and the ticket moves to review or complete, the work can become a generated feed post in the completed timeline.

## How Feed Posts Are Created

Feed posts are stored in the `feed_posts` table. The table was introduced as AI-synthesized summaries of agent work linked to an organization, project, ticket, and optionally an agent session and objective.

Posts are created server-side by the Supabase Edge Function `supabase/functions/generate-feed-post`.

The generator is invoked in these main flows:

- `POST /api/protocol/deliver`: after an agent delivers a ticket and the ticket is moved to review.
- `POST /api/protocol/record-work`: when already-completed chat work is recorded as a ticket in review and should immediately get a feed post.
- `POST /api/protocol/update`: when a protocol update moves a ticket into a review-type status.
- `markObjectiveExecutedAction`: when an objective is manually marked complete in the app.

The calls are intentionally non-fatal. If feed generation fails, the ticket delivery or status change should still succeed.

## What The Generator Reads

The feed generator receives a `ticketId`, `organizationId`, and sometimes a `sessionId`.

It builds a context from:

- the ticket title, acceptance criteria, constraints, project ID, and creator
- the most recent executing or completed objective, falling back to the latest objective
- project name
- the ticket events for the session, excluding system events
- file-change rationales recorded for the ticket or session
- the agent type from the agent session
- tickets spawned during the session
- project-user feed instructions saved in project settings
- the project's repo operations profile, used to derive likely follow-up actions from changed paths

The generator asks Gemini to return a structured JSON object with:

- `title`
- `body`
- `tags`
- `impact_level`
- `tradeoffs`
- `human_actions`
- `files_touched`
- `tickets_created`

If Gemini is unavailable or returns unusable output, the function creates a deterministic fallback post so the feed still has a useful summary.

## Deduplication And Updates

The generator tries to avoid creating duplicate posts for the same work.

When a `sessionId` is available, it first looks for the latest `feed_posts` row for that ticket and session. If one exists, the function updates that post instead of inserting a new one.

Updated posts merge in new source event IDs and refresh the generated title, body, tags, impact level, tradeoffs, human actions, files touched, linked objective, tickets created, and source event window.

When there is no existing post, the function inserts a new `feed_posts` row.

Personal tickets without a project are skipped because feed posts are project-scoped.

## What A Feed Card Shows

Each feed card is rendered by `apps/web/components/features/feed/FeedCard.tsx`.

The collapsed card shows:

- timestamp
- project color and name
- linked ticket identifier and title
- generated post title
- impact level
- human actions, if any
- touched files
- agent type
- source event count
- tags

Expanding the card shows:

- the generated Markdown body
- all human action items
- tradeoff callouts
- tickets created during the session

Touched files are linked through the user's editor scheme when the project has a local working directory. This makes the feed useful as an entry point into review, not just as a passive timeline.

## Human Actions

`human_actions` should only contain proactive tasks a human must perform outside the agent's code changes.

Good human actions include:

- run a database migration
- regenerate types
- deploy a Supabase Edge Function
- add or rotate an environment variable
- configure an external service
- repackage a desktop app
- create an account or credential in a third-party system

The feed generator explicitly avoids adding routine QA instructions like "review the code", "test the feature", or "verify it works". Those are implied by the review workflow and would make the feed noisy.

## Tradeoffs

Tradeoffs are one of the main reasons the feed exists.

A useful feed post should surface decisions such as:

- using a fallback implementation instead of a third-party dependency
- deferring a risky migration step
- changing only a narrow path instead of refactoring a broader area
- keeping behavior compatible with an older schema or client

Tradeoffs appear as structured callouts with the decision, alternatives considered, and rationale.

## Project Feed Settings

Project settings include feed-specific options in `apps/web/components/modals/project-settings/FeedPage.tsx`.

Users can save project-user feed post instructions. These instructions are appended to the generation prompt for that user and project.

Use these instructions to shape what the generator emphasizes. For example:

- call out Electron changes that require repackaging
- mention when database work requires generated types
- emphasize deployment steps for edge functions
- prefer certain tag conventions

The same settings page can build a repo operations profile in the desktop app. That profile is a compact snapshot of deployable surfaces, migration systems, codegen steps, tests, and workspace boundaries. The feed generator uses it to derive accurate candidate human actions without sending the raw file tree to Gemini.

## Organization Feed Settings

Organization settings include a feed retention setting in `apps/web/components/modals/organization-settings/FeedPage.tsx`.

The `feed_retention_days` value controls how long feed posts should be retained. The setting is constrained to 1 through 365 days and defaults to 30.

## Data Access And Security

Feed posts are readable by authenticated users who are members of the post's organization.

Insert, update, and delete access is reserved for the service role. Normal users do not create or edit feed posts directly; they affect the feed by working through tickets, objectives, protocol updates, deliveries, and feed settings.

## Realtime, Pagination, And Offline Cache

The feed list uses an infinite query with a page size of 20 and loads older posts as the user scrolls.

New feed posts appear through Supabase Realtime on `feed_posts` inserts. The client enriches realtime rows with project, ticket, objective, and file-change data, then merges the new post into the existing query cache.

The feed also caches recent posts in local storage for the Electron offline screen. The offline cache stores a compact subset of recent post data so users can still see recent feed context when disconnected.

## When Users Should Open The Ticket Instead

The feed is optimized for scanning. Open the underlying ticket when you need:

- the full objective text
- all agent updates
- blocking questions and answers
- delivery artifacts
- exact change rationales
- attachments
- follow-up objective history
- the current review or completion state

In short: use `/feed` to monitor and triage recent agent work; use the ticket page to make final review decisions.
