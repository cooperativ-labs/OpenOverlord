# Overlord ChatGPT App publication packet

Last reviewed: 2026-07-10

## Submission assessment

**Not ready to submit publicly yet.** The MCP server, OAuth discovery flow,
scoped token issuance, tool schemas, risk annotations, and presentation-only
widget resources are implemented. The public submission remains blocked on a
real public deployment, verified publisher identity, published privacy and
terms pages, reviewer demo credentials, final screenshots, and a manual
ChatGPT web/mobile smoke test.

## App listing draft

| Field | Draft |
| --- | --- |
| App name | Overlord |
| Short description | Plan, track, and deliver engineering work from ChatGPT. |
| Long description | Overlord connects ChatGPT to your authorized engineering workspace. Find projects and missions, inspect objectives and delivery history, create clearly scoped work only when you ask, and keep mission progress up to date. Overlord uses OAuth and your existing workspace permissions; it never accesses your local files, runners, worktrees, or branches from ChatGPT. |
| Publisher | **TODO:** verified individual or business name in the OpenAI Platform Dashboard. |
| Logo | **TODO:** supply a square, high-resolution brand logo that matches the published app name; avoid OpenAI marks or implied endorsement. |
| Screenshots | **TODO:** capture the project selector, mission list, objective viewer, and file-change viewer in ChatGPT, using the portal's current required dimensions. |
| Privacy policy | **TODO:** publish a production URL, for example `https://<public-domain>/privacy`; do not submit a placeholder. |
| Terms | **TODO:** publish a production URL, for example `https://<public-domain>/terms`; do not submit a placeholder. |

## Public tool surface

| Tool | User-visible behavior | Safety annotation |
| --- | --- | --- |
| `overlord_resolve_project` | Resolves a project the user identifies. | Read-only |
| `overlord_search_missions` | Lists matching missions in the connected workspace. | Read-only |
| `overlord_load_mission_context` | Shows one mission's objectives, history, artifacts, and shared context. | Read-only |
| `overlord_create_mission` | Creates a draft mission in an explicit project. | Write; no implicit project selection |
| `overlord_add_objectives` | Adds draft objectives to a mission. | Write |
| `overlord_attach_session` | Begins requested mission work. | Write |
| `overlord_update_session` | Posts requested mission progress or a decision. | Write |
| `overlord_deliver_session` | Delivers requested completed work. | Write |

All tools have `openWorldHint: false` and `destructiveHint: false`: the public
surface does not publish external content or delete/overwrite data. Write tools
are marked `readOnlyHint: false`, are narrowly scoped to the connected
workspace, and require explicit user intent in their descriptions. The server
provides input and output schemas plus `structuredContent`; the presentation
resources are self-contained and have an empty resource/network/frame CSP.

## Authentication and error behavior

1. ChatGPT discovers `/.well-known/oauth-protected-resource/mcp`, then the
   authorization-server metadata.
2. It registers a public OAuth client, uses authorization-code + PKCE, and
   opens `/oauth/authorize`, which routes to the signed-in Overlord approval
   page.
3. The approval page names the client, redirect host, and requested scopes.
   Denial redirects with `access_denied`; invalid requests show a clear browser
   error instead of silently approving.
4. Approval creates a workspace-scoped, 90-day `mission_lifecycle` token. The
   code is single-use and expires after five minutes. Failed PKCE/client/resource
   exchanges revoke the token before returning `invalid_grant` or
   `invalid_target`.
5. Missing, malformed, revoked, or expired bearer credentials return `401` from
   `/mcp` with `WWW-Authenticate: Bearer` protected-resource metadata. The
   client can reconnect rather than receiving a misleading tool result.

This matches OpenAI's current requirement for OAuth 2.1 MCP authorization,
protected-resource metadata, PKCE, and resource binding. [OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth)

## Deployment and reviewer setup

1. Deploy the backend on a public HTTPS domain with `OVERLORD_MCP_ENABLED=true`.
2. Set `OVERLORD_PUBLIC_URL` or `OVERLORD_WEBAPP_PUBLIC_URL` to that canonical
   HTTPS origin. Deploy the web app with the matching OAuth proxy/discovery
   configuration when it is on a different origin.
3. Confirm unauthenticated `GET /mcp` returns `401` and a protected-resource
   `WWW-Authenticate` header; confirm the two protected-resource paths and
   authorization-server metadata return JSON.
4. In ChatGPT Developer Mode, connect the exact public `/mcp` URL. Complete the
   OAuth consent flow, search a mission, inspect context, and perform one
   explicit create/update/deliver test in a disposable workspace.
5. Create a fully featured reviewer account with sample projects and missions.
   It must work without MFA, network allowlists, or additional setup. Record
   test prompts and expected results.
6. Verify the four widgets on ChatGPT web and mobile. Check widget console/UI
   errors, loading/error states, and that no private tokens or local paths are
   rendered.

OpenAI requires a public, non-test MCP domain and a resource CSP for an app
submission; tool scans import schemas, annotations, UI metadata, and server
instructions. [OpenAI submission guide](https://developers.openai.com/apps-sdk/deploy/submission)

## Submission checklist

- [ ] Publisher identity is verified under the exact directory name.
- [ ] Submitter has `api.apps.write`; reviewers have `api.apps.read`.
- [ ] Production HTTPS MCP URL is reachable outside the company network.
- [ ] OAuth discovery, dynamic registration, consent, PKCE, denial, expiry,
  revocation, and invalid-resource cases pass against the production origin.
- [ ] Tool scan shows all eight tools, input/output schemas, and annotations.
- [ ] Tool annotations and submission justifications accurately match behavior.
- [ ] Privacy policy is public and covers data categories, purposes, recipients,
  retention, deletion controls, and tool-result handling.
- [ ] Terms of use are public and linked in the submission.
- [ ] Reviewer account credentials and sample data are active and MFA-free.
- [ ] Screenshots accurately show the four working widgets.
- [ ] Test prompts, expected responses, and manual web/mobile results are
  recorded.
- [ ] App name, description, logo, company URL, localizations, and public
  countries are final.
- [ ] Security review covers prompt injection, input validation, scopes, audit
  logging, retention, and least-privilege data handling.

OpenAI's guidelines require transparent auth, minimal inputs, accurate action
labels, predictable errors, and a published privacy policy; reviewers also
require demo credentials for authenticated apps. [OpenAI app submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)

## Follow-up tasks blocking public publication

1. Provision and monitor the production HTTPS MCP endpoint with an exact
   production CSP.
2. Publish privacy policy and terms pages at final URLs.
3. Complete OpenAI organization or individual verification and grant app
   management permissions.
4. Create, test, and securely deliver a reviewer demo account with sample data.
5. Capture final branding assets and screenshots, then complete Developer Mode
   web and mobile smoke tests.
6. Decide whether the 90-day non-refreshable MCP token lifetime is the desired
   product policy; document the reconnect experience if retained.
