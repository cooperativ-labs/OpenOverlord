---
name: security-audit
description: Standardized workflow for conducting external-facing security audits of Overlord product surfaces and documenting them in root-level dated reports.
---

# security-audit

Use this skill when asked to perform or document a security audit for the site or a defined product surface.

## Purpose

Produce a security review that is suitable for external consumption:

- Clear and concise for customer stakeholders
- Specific enough for customer security teams to assess risk
- Organized by product surface, with an executive summary first
- Explicit about the AI model used to conduct the audit

## Output Location And Naming

- Save every audit in `security-audits/` at the repository root.
- Name each audit file by date using ISO format: `YYYY-MM-DD.md`.
- If multiple audits are created on the same date, append a short suffix such as `YYYY-MM-DD-follow-up.md`.
- Do not store security audit reports in `docs/`, `code-reviews/`, or ad hoc folders.

## Audit Workflow

### 1. Define scope before reviewing

State the exact scope at the top of the report:

- Product or environment reviewed
- Product surfaces included
- Audit date
- AI model used
- Known limitations, if any

If the request is ambiguous, narrow the scope to the concrete surfaces you can verify from the codebase and state that choice explicitly.

### 2. Review by product surface

Break findings down by product surface rather than by file list. Choose the surfaces that match the work, for example:

- Authentication and access control
- Public web pages
- Authenticated application flows
- API routes and server actions
- Database and Supabase policies
- Edge functions, background jobs, and integrations (REVIEW EACH EDGE FUNCTION TO DETERMINE IF HAS SECURITY BUILT IN, OR REQUIRES JWT AUTHENTICATION)
- Client-side secrets, tokens, and configuration
- Logging, telemetry, and error reporting
- Infrastructure and deployment configuration

Do not force empty sections. Include only surfaces that were actually reviewed.

### 3. Record findings precisely

For each finding, include:

- Severity: `Critical`, `High`, `Medium`, `Low`, or `Informational`
- Surface
- Short title
- Why it matters
- Evidence
- Recommended remediation

Evidence should point to concrete code paths, routes, settings, or observed behavior. Avoid vague claims that cannot be traced back to the product.

### 4. Write for external readers

- Use direct, neutral language.
- Prefer short paragraphs over long narrative blocks.
- Explain impact in practical terms.
- Avoid internal shorthand unless it is defined.
- Call out uncertainty when evidence is incomplete.

Do not present speculation as a confirmed vulnerability.

## Required Report Structure

Every audit should follow this structure:

```markdown
# Security Audit - YYYY-MM-DD
∑
## Executive Summary

- Overall risk posture
- Most important findings
- Whether any immediate customer action is recommended

## Audit Metadata

- Date: YYYY-MM-DD
- AI model: <model name>
- Scope: <what was reviewed>
- Method: Code review, configuration review, manual walkthrough, or other applicable methods
- Limitations: <optional>

## Findings Overview

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Informational | 0 |

## Product Surface Reviews

### <Surface Name>

#### Finding: <Short title>
- Severity: <severity>
- Why it matters: <risk summary>
- Evidence: <code path, route, behavior, or configuration>
- Recommendation: <specific remediation>

#### Finding: <Short title>
- Severity: <severity>
- Why it matters: <risk summary>
- Evidence: <code path, route, behavior, or configuration>
- Recommendation: <specific remediation>

## Positive Controls

- List meaningful controls that reduce risk, if observed.

## Recommended Next Steps

- Prioritized remediation or follow-up validation steps
```

## Executive Summary Requirements

The executive summary must appear before detailed findings and should answer:

- What was reviewed
- Whether the current posture appears acceptable for customer evaluation
- Which risks matter most right now
- Whether the audit found issues that should block adoption or require remediation first

Keep it brief, but do not strip out the decision-useful content.

## Severity Guidance

Use these labels consistently:

- `Critical`: Likely to enable major compromise, unauthorized access, or sensitive data exposure with minimal barriers
- `High`: Serious weakness with meaningful exploitation or business impact
- `Medium`: Important weakness that should be addressed but is not an immediate systemic failure
- `Low`: Limited impact issue or defense-in-depth gap
- `Informational`: Useful observation, clarification, or positive note without direct security risk

If severity is uncertain, choose the lower defensible rating and explain the uncertainty.

## Minimum Quality Bar

- Include at least one evidence point for every non-informational finding.
- Separate confirmed findings from open questions.
- Prefer a small number of substantiated findings over a long list of weak ones.
- If no meaningful issues are found, say so directly and still document reviewed surfaces and residual risk.

## Example

Example output path:

```text
security-audits/2026-05-25.md
```

Example metadata block:

```markdown


<!-- version: 1.1.0 -->
