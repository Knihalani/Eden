Your mission is to perform a complete, uncompromising, end-to-end audit and fix pass across this entire codebase until it is genuinely production-ready, stable, test-covered, and internally consistent.

You are not doing a superficial review. You are responsible for deeply inspecting the architecture, tracing real execution paths, finding latent defects, fixing root causes, writing missing tests, validating all critical flows, and refusing to declare completion until the system works cleanly across backend, frontend, and full-stack integrations.

You must operate autonomously for as long as necessary, including many hours or days if required. Do not stop at partial progress. Do not stop after finding issues. Do not stop after making fixes. Do not stop after writing tests. Continue iterating until the codebase passes all defined quality gates and there are no known unresolved critical or high-severity defects.

CORE DIRECTIVE
Do a full-codebase audit, not a spot check.
Be exhaustive, skeptical, and systematic.
Assume there are hidden failures until proven otherwise.
Verify behavior through code inspection, test execution, runtime validation, and end-to-end tracing.
Fix root causes, not just symptoms.
Prefer deterministic, maintainable fixes over hacks.
Add or improve tests to lock in every meaningful fix.
Keep iterating until everything passes.
Do not mark the task complete while any broken route, broken UI action, failing test, unhandled exception, import error, schema mismatch, accessibility blocker, console error, or integration defect remains.
Do not simply fix, but also polish all UI, spaghetti code etcetera

NON-NEGOTIABLE DEFINITION OF DONE
The task is not complete until all of the following are true:
All backend routes and handlers execute without unhandled exceptions under valid, invalid, and edge-case inputs.
No backend endpoint produces an avoidable 500 error.
Error handling is consistent, explicit, and safe.
Environment configuration is validated at startup with clear failures for missing or malformed values.
Auth, session, permission, and middleware flows function correctly.
Database queries, transactions, relations, constraints, and migrations are valid and safe.
Frontend pages render without crashes, broken imports, or missing dependencies.
Every button, form, link, menu, modal, drawer, tab, accordion, dropdown, and interactive control is wired correctly and behaves correctly.
Scrolling behavior works correctly across pages, nested containers, sticky elements, infinite lists, modals, and mobile-like overflow contexts.
Frontend loading, empty, success, and error states are handled intentionally.
Frontend and backend contracts match exactly: routes, methods, payloads, query params, headers, status codes, field names, nullability, auth expectations, and pagination shapes.
All relevant tests pass: unit, integration, component, and end-to-end where feasible.
No skipped, flaky, placeholder, or knowingly broken tests remain unless explicitly documented as unavoidable, with reason and risk.
No broken imports, unresolved modules, type errors, lint-critical defects, or console/runtime crashes remain.
A final structured audit report is produced that documents what was audited, what was fixed, what tests were added, what commands were run, what remains risky, and why.

OPERATING MODE
Work in disciplined phases, but loop back as many times as needed:
Discover and map the system.
Audit comprehensively.
Rank issues by severity and blast radius.
Fix critical and high-confidence root causes first.
Write or expand tests around the fixes.
Re-run verification.
Investigate any new failures introduced or revealed.
Repeat until all quality gates pass.

Never assume a file, route, component, or code path is unimportant without proving it.
Never assume generated code is correct.
Never assume passing unit tests mean the app works.
Never assume the frontend is correct because it compiles.
Never assume the backend is correct because one happy-path request succeeds.

REPOSITORY DISCOVERY AND INITIAL MAPPING
Before making broad changes, build a concrete mental model of the codebase:
Identify application entrypoints.
Identify backend framework(s), frontend framework(s), package manager(s), test runner(s), ORM/database layer(s), auth provider(s), state management pattern(s), and build tooling.
Identify all apps, packages, services, workers, scripts, background jobs, cron tasks, queues, and shared libraries.
Identify environment files, config loaders, schema definitions, migration directories, seed scripts, container files, CI config, and deployment config.
Identify route definitions on both backend and frontend.
Identify API clients, fetch wrappers, SDK layers, service modules, repositories, adapters, and DTO/serializer layers.
Identify areas with no tests or suspiciously low test coverage.
Identify files that appear dead, duplicated, partially migrated, or inconsistent with current architecture.

Create an internal audit map covering at minimum:
Backend route inventory
Middleware inventory
Auth/session flow map
Data model and migration map
Frontend page and route inventory
Interactive component inventory
API call inventory
Cross-layer integration map from UI action -> request builder -> backend route -> service -> database

BACKEND AUDIT: FULL DEPTH
Inspect every backend route, controller, handler, resolver, middleware, service, repository, model, and utility involved in request handling.

For every backend endpoint, verify all of the following:
Route exists and is actually mounted.
HTTP method is correct.
Path naming is internally consistent.
Request parsing is safe.
Input validation exists and is enforced.
Invalid input returns an intentional 4xx response, not a 500.
Auth and permission checks are correct.
Business logic handles missing data, duplicates, malformed states, race conditions, and unexpected null/undefined values.
Database interactions handle not-found, constraint, and transaction failure cases cleanly.
Response codes match actual behavior.
Response body shape is consistent and documented by code.
Sensitive data is not leaked in responses.
Logging is useful but does not expose secrets.
Errors are translated into safe, structured responses.
Async flows are awaited properly.
Timeouts, retries, and external dependency failures are handled intentionally where applicable.

Specifically audit these backend risk areas:
Route registration
Missing mounts
Duplicate routes
Shadowed routes
Dead routes still exported but unreachable
Versioned API inconsistencies

Input validation
Missing schema validation
Weak coercion
Inconsistent parsing of params/query/body
Missing enum checks
Missing string trimming/normalization when required
Missing numeric bounds
Unsafe date parsing
Missing file upload validation if applicable

Error handling
Uncaught promise rejections
Throw paths that bypass response formatting
Middleware chains that call next incorrectly
Silent catch blocks
Swallowed errors causing false success responses
Internal exceptions leaking stack traces or implementation details
Inconsistent error response envelopes

Auth and session
Missing auth checks on protected routes
Public routes accidentally exposing user data
Session lookup failures
Token parsing mistakes
Expired token handling
Role/permission drift
Multi-tenant scoping issues
User impersonation or owner-check mistakes
CSRF protections where relevant
Cookie flags, session security, and secret validation

Database and ORM behavior
Queries that can throw on null assumptions
N+1 patterns in hot paths
Missing indexes on common lookup fields or joins
Incorrect eager/lazy loading
Broken relations or orphan assumptions
Transaction boundaries that can leave partial writes
Upsert/create/update race conditions
Soft-delete filtering mistakes
Pagination bugs
Unsafe raw SQL or injection risks
Schema drift between models and migrations
Bad default values
Missing not-null handling

Migrations and schema management
Missing migrations
Broken migration ordering
Non-idempotent scripts
Destructive changes without guards
Seeds that assume invalid state
Startup failures when DB schema is partially applied

Config and environment
Missing required env vars
No startup validation
Inconsistent names across environments
Wrong fallback defaults
Misconfigured ports, hosts, base URLs, secrets, CORS origins, database URLs, redis URLs, storage settings, third-party keys
Dangerous production defaults

Middleware and platform concerns
CORS configuration correctness
JSON/body size limits
Compression issues
Security headers if applicable
Request ID / correlation handling if present
Rate limiting if expected
File upload handling
Static asset serving
Health check endpoints
Graceful shutdown handling

Dead or broken backend code
Unused services
Dangling imports
Deprecated adapters still referenced
Copy-pasted legacy handlers
Duplicate validators/utilities drifting apart

BACKEND FIX STANDARD
Every backend fix must:
Eliminate the root cause.
Preserve intended business behavior unless behavior is clearly broken.
Add or update validation where missing.
Produce correct status codes.
Return a consistent response contract.
Avoid introducing hidden breaking changes.
Be covered by tests for success, invalid input, and failure modes.

FRONTEND AUDIT: FULL DEPTH
Inspect every page, layout, route, component, hook, store, client-side service, utility, and styling dependency involved in rendering and interaction.

For every screen and interactive UI element, verify all of the following:
The page renders without runtime errors.
All imports resolve.
All buttons are connected to the correct handlers.
Click targets are actually clickable and not blocked by overlay, disabled state bugs, z-index issues, pointer-events mistakes, or stale refs.
Visual feedback exists where expected for hover, active, focus, disabled, loading, and success/error states.
Forms validate inputs correctly before submit where appropriate.
Submit actions fire exactly once and handle rapid interaction safely.
Errors are surfaced to the user clearly.
Empty states are intentional.
Loading states are visible and accurate.
Success states reset or navigate correctly.
Navigation links route to valid destinations.
Browser back/forward behavior is sane.
Route params are handled safely.
Conditional rendering does not strand the user in dead-end UI.
Components recover gracefully from failed data fetches.
State updates are correct and do not depend on stale closures or broken effects.
Lists have stable keys where required.
No avoidable console errors or warnings remain.

Specifically audit these frontend risk areas:
Buttons and actions
Buttons with no handler
Wrong handler bound
Disabled forever because of bad state
Double submission bugs
Incorrect optimistic updates
Action appears to succeed but does nothing
Action triggers wrong API route or payload

Forms
Missing client validation
Validation contradicting backend rules
Inputs not bound correctly
Default values causing uncontrolled/controlled warnings
Error messages not displayed
Submit state not reset
File/date/select inputs mishandled
Keyboard submission issues

Navigation and routing
Broken links
Misnamed routes
Client-side routes not matching server routes
Redirect loops
Protected route logic failures
404 handling gaps
Deep links failing

Scroll and layout behavior
Infinite scroll not triggering or over-triggering
Sticky headers overlapping content
Modals that trap scroll incorrectly
Overflow containers clipping content or hiding CTAs
Scroll restoration issues on navigation
Mobile viewport edge cases
Focus lost after modal open/close or navigation

Component integrity
Missing exports/imports
Broken lazy loading
Suspense/loading boundary issues
Hooks called conditionally
Memoization bugs hiding updates
Ref forwarding issues
Portal/modals/drawers not mounting correctly

State management
Store slices out of sync with backend responses
Cache invalidation bugs
Stale data after mutation
Duplicate sources of truth
Race conditions between requests
Incorrect optimistic rollback
Local state diverging from server state

Data fetching
Wrong base URL
Wrong headers
Missing auth tokens/cookies
Wrong request method
Missing query params
Response parsing assumptions
No error boundary or fallback
Retrying bad requests incorrectly

Accessibility basics
Buttons/links semantically correct
Form controls labeled
Modals manage focus reasonably
Keyboard navigation works for primary interactions
Visible focus state exists
Basic ARIA only where needed and correct
Click-only interactions get keyboard access where appropriate

Dead or broken frontend code
Unused pages/components
Broken imports
Old API clients still referenced
Duplicated components drifting in behavior
Stale feature flags or dead branches

FRONTEND FIX STANDARD
Every frontend fix must:
Correct the actual behavior, not just the visuals.
Preserve intended UX unless it is clearly broken.
Handle loading, success, empty, and error states intentionally.
Keep interactions accessible at a basic practical level.
Be covered by component or integration tests where meaningful.

FULL-STACK INTEGRATION AUDIT
Trace real end-to-end behavior from user interaction to persistent state and back.

For every meaningful frontend action, map:
UI entry point -> handler -> state/update layer -> request builder/client -> backend route -> middleware -> service -> DB/query/external dependency -> response serializer -> frontend consumer -> rendered UI state

For each flow, verify:
Route path matches exactly.
HTTP method matches.
Required headers are sent.
Auth credentials are sent and accepted correctly.
CORS behavior is correct for the deployment model.
Request payload field names match backend expectations.
Query param names and encodings match.
Response field names match frontend usage.
Nullability assumptions match on both sides.
Pagination contracts match.
Sorting/filter semantics match.
Date/time formats match.
Enum/string literal values match.
Error contracts match.
Redirect/re-auth flows match.
File upload/download expectations match where applicable.

Find and fix all mismatches including:
snake_case vs camelCase drift
id vs _id vs uuid mismatches
status vs state mismatches
nested vs flat response shape mismatches
boolean/string coercion bugs
frontend expecting arrays while backend returns object wrappers
frontend assuming 200 on create while backend returns 201 or vice versa
backend returning null where frontend expects omitted fields or vice versa

TEST STRATEGY: MANDATORY
Do not rely on existing tests alone. Expand the test suite to prove the fixes and expose hidden regressions.

Required test coverage expectations:
Backend unit tests where business logic is isolated.
Backend integration tests for every meaningful route.
Frontend component tests for interactive components.
Full-stack integration tests where layers are tightly coupled.
End-to-end smoke coverage for critical user journeys where feasible in the repo’s tooling.

For backend route tests, cover at minimum:
Success path
Invalid input
Unauthorized/forbidden access where applicable
Not found
Conflict/validation failure where applicable
Dependency/internal failure path with safe error response

For frontend tests, cover at minimum:
Render without crash
Primary user interaction works
Correct request/action triggered
Loading state appears when expected
Error state appears when request fails
Success state updates UI correctly
Disabled states and validation behavior

For end-to-end flows, prioritize:
Authentication/login/session restoration if applicable
Core create/read/update/delete flows
Highest-value user workflows
Navigation across major pages
Form submission and resulting UI refresh
Modal and scrolling behavior where critical

TEST QUALITY RULES
No shallow meaningless tests.
No tests that merely assert implementation trivia.
Prefer behavior-focused assertions.
Stabilize flaky tests; do not ignore them.
If existing tests are brittle, refactor them.
If necessary, improve test setup, factories, fixtures, mocks, or seed data.
Keep tests deterministic and maintainable.

SECURITY AND ROBUSTNESS PASS
During the audit, also inspect for practical security and resilience issues:
Missing auth checks
Overly broad data exposure
Unsanitized input in queries or rendering
Unsafe raw SQL or command execution
Secret leakage in logs or client bundles
Misconfigured CORS
Trusting client-provided identifiers without ownership checks
Insecure default config
Missing rate limiting or abuse guards where obviously needed
Error messages exposing internals

Also check for operational robustness:
Startup failures due to missing config
Broken health checks
Crash-prone background jobs
Unhandled async errors
Partial write risks
Retry storms or duplicate side effects

PRIORITIZATION RULES
When many issues are found, prioritize in this order:
Data loss or corruption risks
Security/auth exposure
Guaranteed 500s or app crashes
Broken core user journeys
API contract mismatches breaking frontend/backend integration
Broken buttons/forms/navigation on primary flows
Test gaps around critical logic
Performance/pathological query issues
Dead code and cleanup
Lower-severity UX inconsistencies

EXECUTION RULES
Audit first, but do not stay stuck in analysis forever.
Once a real issue is confirmed, fix it.
After a cluster of fixes, run the relevant tests/build/checks.
If a failure appears, investigate and resolve it before moving on.
If fixing one issue reveals deeper architectural inconsistency, resolve the deeper cause.
If a route or component cannot be confidently validated from static inspection alone, create or run runtime verification.
Continue until the repo is clean by evidence, not intuition.

QUALITY GATES: HARD STOP CONDITIONS FOR COMPLETION
Do not declare success until all applicable gates pass:
Backend test suite passes.
Frontend test suite passes.
Integration/E2E tests pass where configured or added.
Build passes.
Type checks pass.
Lint passes or only non-critical pre-existing exceptions remain and are explicitly documented.
No known unhandled backend error paths remain in audited routes.
No broken primary UI interaction remains.
No broken route/action wiring remains.
No unresolved import/module/runtime crash remains.
No obvious contract mismatch remains between frontend and backend.

ITERATIVE VERIFICATION LOOP
Repeat this loop until stable:
Scan and map current area.
Reproduce or prove the defect.
Fix the root cause.
Add or update tests.
Run targeted verification.
Run broader regression checks.
Review logs, console output, and failures.
Fix newly exposed issues.
Repeat.

Do not stop because progress has been made. Stop only when evidence says the system is stable.

FINAL AUDIT REPORT: REQUIRED OUTPUT
At the end, produce a structured audit report with these sections:
Executive summary
Overall state of the codebase before vs after
Whether production-readiness was achieved
Highest-risk issues found

Repository map
Backend apps/services/modules audited
Frontend apps/pages/components audited
Test suites and tooling used

Issues found and fixed
For each issue include:
Severity
Area
Root cause
User/system impact
Files changed
Fix implemented
Tests added/updated

Test coverage added or improved
New backend integration tests
New unit tests
New component tests
New end-to-end tests
Notable gaps that remain and why

Verification commands run
Build commands
Lint commands
Typecheck commands
Test commands
E2E commands
Any seed/migration/dev server commands used

Quality gate results
Pass/fail status for each gate
Evidence for pass state

Remaining risks
Anything not fully resolvable in-session
Any assumptions made
Any recommended follow-up hardening

File change summary
Every file modified
Short description of why it changed

WORKING STYLE
Be relentless but disciplined.
Be conservative with risky changes and aggressive with verification.
Prefer small, correct, reviewable fixes over sprawling speculative rewrites unless a rewrite is clearly necessary.
Keep the codebase coherent with its existing patterns unless those patterns are the problem.
Do not leave TODOs instead of fixes for issues you can actually resolve now.
Do not hand-wave edge cases.
Do not declare “done” based on optimism.

ABSOLUTE COMPLETION RULE
This assignment is complete only when the backend is behaving cleanly, the frontend interactions work correctly, the full-stack wiring is consistent, the relevant tests pass, and the final report proves what was audited, fixed, and verified. If any critical path is still uncertain, continue auditing and testing until it is no longer uncertain.
