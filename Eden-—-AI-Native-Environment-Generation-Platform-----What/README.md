# Archived — Legacy Environment-Generation Mockups

**Status:** Archived (July 2026). Do not use for sales, demos, or buyer-facing materials.

These static HTML files are early design mockups from the **N07 environment-generation** era. They describe a product narrative Eden has **removed**:

- "Multi-agent pipeline generates environments"
- Hosted SaaS clones / env repro from production failures

## Current product narrative

Eden is an **agent observability and improvement platform**:

1. **Detect** — deterministic issue detection from traces (Agent Issues)
2. **Intervene** — gateway guardrails and inline trajectory intervention
3. **Fix** — fix-in-code chat → PR, MCP autofix
4. **Prove** — regression memory and impact preview
5. **Learn** — evidence-gated nudges and closed-loop promotion

Replacement for env-gen: **D6 Failure Fixture Export** + **D7 Regression Memory** + **F01 live debugger** — no hosted clones.

## Files in this folder

| File | Notes |
|------|-------|
| `landing.html`, `landing-current.html` | Legacy hero copy references env generation |
| `dashboard.html`, `jobs.html`, `job-detail.html` | Mock job/env-gen UI |
| `login.html`, `signup.html`, `settings.html`, `docs.html` | Auth/settings shells |
| `tokens.css`, `DESIGN-MANIFEST.json`, `DESIGN-HANDOFF.md` | Design tokens from mockup phase |
| `research/visual-wow-options.md` | Visual exploration notes |

## Canonical portal

The live product UI is `clients/portal/` (Next.js). Marketing pages: `clients/portal/src/app/(marketing)/`.
