Recommended ready-made components

1) Repo graph / code understanding layer — Recommended: Greptile API
Use: Greptile as the default repo-graph and code-understanding layer when a user links a GitHub repo.
Why this is the best fit: It is already built specifically to index repositories, keep full-codebase context, auto-update on push, and expose that understanding through a query API. It is the closest ready-made product to the exact Greptile-style behavior Eden wants, without building a graph stack from scratch.
Key capabilities from docs: one-time repository indexing, queryable full-codebase context, repo search/query endpoints, GitHub integration, and automatic index updates on push.
Links:
Intro: https://docs.greptile.com/introduction
Quickstart / API flow: https://docs.greptile.com/quickstart
Graph-based codebase context: https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context

Best open-source / self-hosted fallback: CodeGraphContext (CGC)
If Eden wants to avoid a hosted dependency, the best open-source fallback is CodeGraphContext.
It converts repos into semantic, queryable property graphs using tree-sitter + optional SCIP, exposes CLI + MCP + HTTP API, supports incremental updates, and is explicitly designed as a code intelligence engine rather than just a parser.
Link: https://codegraphcontext.github.io/

Important foundation to know: SCIP / Sourcegraph code intelligence
SCIP is not the full end-product by itself, but it is a strong underlying standard for precise symbol/reference intelligence and should be treated as a foundational building block where useful.
Links:
SCIP repo: https://github.com/sourcegraph/scip\?tab\=readme-ov-file
Sourcegraph precise code navigation docs: https://sourcegraph.com/docs/code-navigation/precise-code-navigation

2) Coding agent for autonomous PR creation — Recommended: OpenHands Software Agent SDK + Resolver
Use: OpenHands as the coding-agent framework Eden spawns programmatically when it has high confidence a code change should be made.
Why this is the best fit: It is purpose-built for software engineering, exposes both Python and REST APIs, supports local or remote execution, can run in containers, is designed for long-running code tasks, and already ships a GitHub issue/PR resolver flow that can create draft or ready PRs.
Key capabilities from docs: programmatic agent spawning, async execution, repo-context ingestion, remote agent server, GitHub workflow integration, and resolver flows for fixing issues and uploading branch/draft/ready PRs.
Links:
SDK docs: https://docs.openhands.dev/sdk
Cloud/API article: https://www.openhands.dev/blog/programmatically-access-coding-agents-with-the-openhands-cloud-api
GitHub resolver README: https://github.com/OpenHands/OpenHands/blob/main/openhands/resolver/README.md

Best runner-up for issue-to-patch quality: AutoCodeRover
AutoCodeRover is strong on structure-aware context retrieval and patch generation, and is especially interesting for issue-resolution quality.
However, it is more patch-generation-oriented than complete PR-orchestration-oriented, so it is a better runner-up than primary choice for Eden's production PR system.
Link: https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md
Master Codex Brief

ROLE / MISSION
You are Codex operating as the lead autonomous software engineer for Eden.

Eden is an agent observability and improvement platform. It goes beyond passive observability by using agent data to identify issues, propose improvements, generate tests and simulations, apply guardrails, and in some cases open code changes or PRs automatically. Eden also has broader agent-management ambitions, including acting on observability data rather than only displaying it.

Your mission is to do two things together, as one coordinated body of work:

Perform a complete full-site / full-product stabilization pass on Eden so the current product is genuinely working, polished, and tester-ready.
Revamp Eden's PR-generation system so linked repositories are understood deeply through a repo graph, and PRs are generated only through disciplined, evidence-backed workflows rather than naive automation.

This is not a shallow cleanup. This is a serious end-to-end stabilization and systems-improvement pass.
PRIMARY OBJECTIVE
Deliver a version of Eden that is:
functionally working end-to-end
significantly more stable on both backend and frontend
clean enough to put in front of real testers
operationally coherent as a product
equipped with a much stronger, less naive, more production-worthy PR system

Do not stop at partial improvements. The required end state is a fully working, tester-ready site and product, plus a credible, well-architected PR automation system revamp integrated into Eden's existing architecture.
PROJECT CONTEXT
Known context about Eden:
Eden is an agent observability and improvement platform. It goes beyond passive observability by using agent data to identify issues, propose improvements, generate tests and simulations, and in some cases open code changes or PRs automatically.
It has been described as similar to Laminar in observability, but going further into full agent management, with online guardrails.
It has work around different agent-framework integrations, plus Python and TypeScript SDKs.
The product direction includes observability, guardrails, automated improvement, code changes / PR generation, tests / simulations, SDKs, and developer-facing integrations.
The current priority is not inventing a lot of unrelated new surface area.
The current priority is to make the existing product actually work end-to-end, feel solid, and be suitable for real tester onboarding.

Assume the current codebase may contain:
incomplete flows
auth issues
backend/frontend integration bugs
deployment issues
weak error handling
rough UI states
broken pages or buttons
partial features
inconsistent data flow
fragile environment configuration

Treat the codebase as real but imperfect, and assume hidden breakage is likely.
REQUIRED CLARIFICATION POLICY
Before making substantial architectural changes, ask clarifying questions only when the answer materially affects correctness, risk, external behavior, security, or schema/integration decisions.

Do not ask unnecessary questions just because the brief is broad.

Default assumptions if not blocked:
preserve the current architecture where possible
prefer fixing and hardening over redesigning
do not introduce large speculative rewrites
do not break existing product direction
maintain current UX direction unless there is a clear issue to correct
prefer conservative, evidence-backed changes

Only stop to ask the user if one of the following is true:
a production secret / external credential / environment dependency is missing
two materially different architectures are both plausible and the choice changes external behavior significantly
a destructive migration or irreversible change is required
a critical business rule is impossible to infer from code or product behavior

Otherwise, proceed autonomously.
OPERATING MODE
Operate in clarify-first, then execute hard mode.

First understand the repo and the product as it actually exists.
Then build a written plan.
Then execute milestone by milestone.
After each milestone, validate thoroughly.
If validation fails, repair before moving forward.
Keep durable written state so the run survives long horizons and context compression.

You are allowed to work for a long time, but you are not allowed to drift, lose track, or silently skip broken areas.
CONTEXT / MEMORY / STATUS FILE REQUIREMENTS
Create and maintain these files at repo root if they do not already exist:
Prompt.md — restate the mission, constraints, and acceptance criteria
Plan.md — current phased plan, priorities, and milestone status
Implement.md — concrete work log: what you changed, why, and what is next
Documentation.md — durable product / architecture notes and final audit trail

Update them throughout the run.

These files are not optional. Use them to reduce drift and preserve continuity.
PHASED EXECUTION PLAN

Phase 1 — Reality-based codebase assessment
Understand the current state before changing too much.

Tasks:
map the frontend structure
map the backend structure
identify auth, API, DB, environment, deployment, and integration boundaries
identify the main user flows and intended product paths
identify PR-system-related code paths, data models, jobs, triggers, and GitHub integration points
identify fragile areas, stubs, TODO-heavy sections, dead routes, placeholder UI, and known partial implementations

Output:
a concrete architecture / risk snapshot in Documentation.md
a prioritized defect and risk list in Plan.md

Do not rely on assumptions. Infer from the actual repo.

Phase 2 — Backend bug audit and repair
Do a complete backend audit.

Audit for:
broken API routes
runtime exceptions
auth/session failures
invalid environment assumptions
database query bugs
race conditions
flaky background jobs
bad validation
missing permission checks
bad error handling
deployment/config mismatches
webhook failures
silent failures
logging/observability gaps that make incidents hard to debug

Fix priorities:
anything that breaks core product flows
auth and session reliability
data integrity and API correctness
deployment/runtime stability
background processing reliability
cleanup of secondary backend rough edges

Requirements:
do not patch symptoms only; find root causes
improve error handling and logs where they are too weak to support diagnosis
remove brittle hidden assumptions in backend flows
ensure production behavior matches local expectations as closely as possible

Phase 3 — Frontend polish, debugging, and flow repair
Do a complete frontend audit.

Audit for:
broken pages
broken buttons
forms that fail silently
loading states that never resolve
missing empty states
missing error states
inconsistent spacing/layout
obvious visual roughness
responsiveness issues
unusable mobile/tablet states where relevant
poor navigation continuity
hydration/state sync bugs
broken auth/session UX
frontend/backend mismatch
confusing PR-system UX or linked-repo UX

Fix priorities:
flows that block basic product use
states that make the product feel broken or unfinished
UI coherence and polish
non-blocking visual / interaction issues

Requirements:
preserve the overall product direction
improve polish without drifting into a large redesign
prefer clarity, consistency, and trustworthiness
if an interaction is confusing, make it explicit
if an operation is async, show clear progress and outcome

Phase 4 — Full-stack integration hardening
Verify that frontend and backend work together in realistic usage.

Check and repair:
auth lifecycle
token/session persistence
API contracts
optimistic UI mismatches
stale cache / stale state issues
form submission flows
background job visibility in UI
repo linking flow
GitHub-related flows
observability ingestion to user-facing product surfaces
PR-system trigger-to-result handoff

Run realistic end-to-end flows instead of isolated code inspection only.

Phase 5 — PR system revamp
Redesign and implement Eden's PR system using existing tools, not custom-from-scratch graph or coding-agent infrastructure.

This phase is a required part of the brief, not a stretch goal.
PR SYSTEM REVAMP — PRODUCT REQUIREMENTS

High-level goal
Eden's PR system should evolve from a simplistic automation concept into a disciplined, evidence-backed improvement pipeline.

When a user links a GitHub repository to Eden, Eden should gain a deep understanding of that repository and only generate PRs when the evidence justifies it.

The system must be powerful, but not overzealous.

Mandatory external tools to use
Use these ready-made components rather than building equivalents from scratch:

Repo graph / repo understanding
Primary choice: Greptile API
Fallback if self-hosted/open-source is required: CodeGraphContext
Underlying standard to leverage where useful: SCIP / Sourcegraph indexers

Coding / PR agent
Primary choice: OpenHands Software Agent SDK + Resolver
Runner-up / reference for structure-aware issue-to-patch work: AutoCodeRover

Do not build a custom semantic code graph stack from first principles unless there is an absolutely unavoidable gap.
Do not build a custom autonomous PR agent from scratch if OpenHands can be used.
PR SYSTEM REVAMP — ARCHITECTURE

A. Repo graph on link
When a user links a GitHub repo to Eden:

Store the repo metadata and default branch.
Kick off repo indexing using Greptile.
Persist enough metadata to track graph freshness, including at minimum:
repo identifier
branch
latest indexed commit SHA
indexing status
last successful index time
last queryable graph version
Make the graph queryable by Eden services responsible for:
context gathering
root-cause analysis
PR candidate generation
PR description generation
Keep the graph reasonably fresh:
update on push events where practical
otherwise refresh on a schedule
avoid expensive full rebuilds when an incremental refresh or re-index trigger is sufficient

The graph should allow Eden to understand:
file structure
symbols
references
dependencies
cross-file relationships
relevant architectural patterns
likely areas affected by an incident or performance issue

B. Incident-driven PR trigger
When Eden detects a service outage or quality degradation:

Step 1 — Spawn a lightweight context-gathering agent first
This agent should be cheap and focused.

Its job is to:
gather all relevant Eden observability data
gather recent deploy / change context if available
identify the time window of the degradation
summarize impacted services, components, endpoints, flows, or agents
correlate symptoms with likely code areas using the repo graph
perform root-cause analysis to the highest confidence possible
compile a structured internal report

The output should include:
what happened
when it started
severity / user impact
evidence used
likely root cause classification
confidence score or confidence band
whether the issue appears code-fixable via the linked repo
suggested next action

Step 2 — Only spawn the coding agent if the issue is genuinely code-fixable
If and only if the evidence strongly suggests the problem is fixable by code in the linked repo:
spawn OpenHands programmatically
provide the repo, branch, issue description, incident evidence, affected areas, and graph-derived context
instruct it to make the smallest high-confidence change that addresses the problem
require validation before PR creation

If the issue appears instead to be:
infrastructure-only
environment-only
third-party outage
secrets/config issue outside repo scope
ambiguous / low-confidence

then do not open a PR.
Produce the report only.

Step 3 — PR output policy
When the coding agent does create a PR:
default to draft PR unless confidence and validation are very strong
include a clear explanation of:
the incident observed
evidence from Eden that triggered action
why the repo/code was judged to be causal
what changed
validation run
residual risk

The PR must read like a disciplined engineering artifact, not a vague AI summary.

C. Scheduled optimization PR trigger
On a configurable schedule, default daily:

Spawn a lightweight review / optimization agent.
It reviews all relevant Eden data collected since the last run.
It identifies real, evidence-backed improvement opportunities.
It uses the repo graph to understand where changes would belong.
If improvements are justified, it spawns the coding agent to implement them and open PR(s).

Optimization categories may include:
reliability fixes
error handling improvements
missing retries or timeouts
performance improvements
instrumentation / observability gaps
test coverage additions around recurring failure modes
clearer fallbacks or guardrails
code cleanups directly justified by repeated runtime evidence

This scheduled system must also be non-overzealous.
It should not manufacture busywork PRs.

Preferred behavior:
batch multiple related improvements into fewer, higher-quality PRs
skip PR creation if evidence is weak
prefer one strong PR over many small noisy ones
PR SYSTEM REVAMP — DECISION AND SAFETY RULES

High-confidence gate before PR creation
A PR may be opened only if most of the following are true:
there is clear evidence from Eden data that a meaningful issue or improvement exists
the issue maps plausibly to code in the linked repo
the likely fix area is reasonably localized
the coding agent can validate the proposed change through tests, checks, or other evidence
the risk of making things worse is acceptable
there is no stronger explanation that points to infra/config/external causes

If confidence is not high enough, do not open a PR.
Return a report instead.

Anti-overzealous rules
The system must not:
open PRs for weak hunches
spam multiple PRs for one loosely understood symptom
create PRs when the root cause is mostly infrastructure or configuration outside repo scope
repeatedly propose the same fix after rejection/failure without new evidence
generate speculative refactors disguised as incident fixes

Circuit breaker and rate limiting
Implement protective controls such as:
per-repo PR rate limits
cooldown periods after failed or rejected PRs
duplicate-detection against recent PRs/reports
escalation thresholds when too many incidents fire in a short window
a circuit breaker that temporarily disables auto-PR creation if noise or failure rate is too high

Cost discipline
The context-gathering agent and coding agent should be lightweight by default.
Guidelines:
do not spawn expensive coding runs unless the pre-check suggests a real code-fix opportunity
prefer smaller graph/context queries first
reuse existing repo graph/index state instead of re-building context from scratch every time
keep scheduled runs bounded and incremental
PR SYSTEM REVAMP — IMPLEMENTATION REQUIREMENTS

Implement the revamp so it fits cleanly into the existing Eden architecture.

Required implementation outputs:
a clear repo-link indexing flow
a graph freshness strategy
a context-gathering workflow for incidents
a scheduled optimization workflow
a disciplined handoff into OpenHands for code-fix PR generation
storage for reports, decisions, confidence, and PR history
rate limiting / circuit breaker logic
user-visible status where appropriate

The implementation should make it easy to answer:
why was this PR created?
what evidence triggered it?
why did Eden decide this was a code issue?
what repo graph context was used?
what validation was run?
why was no PR created in ambiguous cases?
BACKEND REQUIREMENTS
make incident analysis and scheduled review pipelines robust and restartable
ensure all async/background work is idempotent where possible
ensure webhook flows and scheduled jobs do not duplicate work
persist sufficient job/run state for observability and debugging
make failures inspectable rather than silent
ensure GitHub integration failures are surfaced clearly
ensure PR-generation workflows are safe under retries
FRONTEND REQUIREMENTS
If the product exposes linked repos, incidents, reports, or PR-generation state in the UI:
make those states understandable
show indexing status clearly
show when a repo is ready for PR intelligence
show when Eden created only a report instead of a PR and why
show scheduled optimization activity in a way that feels intentional, not mysterious
show PR history / recent actions if such a surface exists or should exist naturally

Do not invent bloated dashboards if a smaller UX change solves the trust problem.
DATA / DATABASE / AUTH REQUIREMENTS
Audit and stabilize all relevant data flows.

Specifically verify:
linked repo records are correct and normalized
auth around repo linkage and PR operations is sound
job records and run history persist correctly
duplicate incident or optimization runs are deduplicated appropriately
PR history is stored cleanly enough to support anti-spam logic
graph/index metadata does not become stale or contradictory

If schema changes are necessary, keep them disciplined and minimal.
BUG HUNT / AUDIT REQUIREMENTS
This is a bug hunt, not a cosmetic skim.

You must actively search for:
obvious failures
hidden failures
partial implementations
misleading success states
swallowed errors
flaky or brittle integrations
weak type assumptions
stale or dead code around critical flows

Do not assume something works because the code looks fine.
Prove it.
TESTING AND QUALITY GATES
No claim of completion is allowed without evidence.

At appropriate milestones, run and report:
relevant unit tests
relevant integration tests
lint
typecheck
build
smoke tests
focused manual end-to-end checks for key product flows

For the PR system revamp specifically, validate at least:
repo link and index kickoff flow
graph status tracking
incident report-only path
incident -> code-fix PR path
scheduled optimization path
duplicate suppression
circuit breaker / rate limiting behavior
PR description quality

If tests are missing for critical logic, add them.
TOOLING / BUILD / LINT / TYPECHECK REQUIREMENTS
Ensure the repo reaches a state where the normal engineering checks are trustworthy and green, or where failures are clearly explained with a concrete remediation path.

Do not leave the codebase in a state where:
build is broken
lint is chaos
type errors are ignored in core flows
tests are obviously stale in the exact areas you changed
PERFORMANCE / SECURITY / RELIABILITY CHECKS
Perform a practical pass on:
obvious performance regressions
unsafe secrets handling
webhook/auth vulnerabilities
over-permissive GitHub actions or tokens
unbounded background jobs
concurrency hazards
retry storms
expensive graph or agent operations triggered too easily

The PR system must be reliable enough that it will not become a source of operational noise.
RULES FOR MAKING CHANGES
prefer root-cause fixes over superficial patches
prefer small, high-leverage changes over sprawling rewrites
preserve working behavior unless there is a good reason to change it
avoid speculative abstraction
do not bolt on a homemade code graph if Greptile or CGC can do the job
do not bolt on a homemade coding-agent framework if OpenHands can do the job
keep new complexity proportional to the value gained
document architectural decisions as you make them
STOP CONDITIONS / WHEN TO ASK THE USER AGAIN
Ask the user again only if:
a critical external secret, token, or permission is missing
there is a forced choice between materially different product behaviors for the PR system
a destructive migration is required and cannot be avoided
a core business rule cannot be inferred from code, UI, or current product behavior

Otherwise continue autonomously until the work is complete.
FINAL DELIVERABLES / FINAL REPORT FORMAT
When finished, provide a final report that includes:

1. Executive summary
what was stabilized
what was fixed
what was improved
whether Eden is now tester-ready

2. Backend audit results
issues found
root causes
fixes made
remaining risks

3. Frontend audit results
issues found
fixes made
polish improvements
remaining UX risks

4. PR system revamp results
what repo-graph approach was integrated
how graph freshness works
how incident-driven PR generation works
how scheduled optimization runs work
what anti-overzealous protections were added
what validation was run

5. Changed files
grouped by subsystem
short explanation per important file

6. Validation evidence
tests run
lint/typecheck/build results
smoke flows checked

7. Remaining risks / next steps
anything still incomplete
anything that requires credentials, infra work, or product decisions

Do not declare success vaguely. Be explicit, evidence-based, and honest about residual risk.
DONE CRITERIA
This task is done only when all of the following are true:
the Eden site/product is substantially more stable and polished
core flows work end-to-end
obvious breakage is removed
backend and frontend are better aligned
repo linking to code-understanding infrastructure is clearly designed and/or implemented
PR generation is no longer naive and has disciplined gating
incident-driven and scheduled PR triggers are both architected coherently
overzealous PR behavior is actively prevented
validation evidence is provided
the product is credibly ready for real tester use

If any of that is missing, keep working.

