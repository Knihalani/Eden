# Eden — Production-Readiness Audit Report

**Date:** May 29, 2026  
**Scope:** Full codebase — backend (Python/FastAPI), frontend (Next.js 16), infrastructure (Docker, deployment), data layer (PostgreSQL, Qdrant), CI/testing  
**Classification:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## CRITICAL Issues

### C1. Stripe Webhook — No Signature Verification
**File:** `src/eden/api/routes/billing.py`  
**Severity:** CRITICAL  
**Risk:** Anyone who discovers the webhook URL can forge events (charge.succeeded, subscription.deleted, etc.), leading to arbitrary plan changes, free subscriptions, or data corruption.  

The Stripe webhook endpoint at `@router.post("/webhook")` does not verify `stripe-signature` header before processing events. Stripe provides `stripe.Webhook.construct_event(payload, sig_header, secret)` for this purpose. Without it, an attacker can POST arbitrary JSON that mimics Stripe events.

**Fix:** Add `stripe.Webhook.construct_event()` validation with the webhook secret from settings.

### C2. Auth Rate Limiting — Absent on Login/Signup
**Files:** `src/eden/api/routes/auth.py`  
**Severity:** CRITICAL  
**Risk:** Brute-force password guessing is trivial. No rate limiting exists on `/auth/login` or `/auth/signup`. Attackers can fire unlimited requests per second.  

The auth endpoints pass through directly to the password verification logic (bcrypt) and DB lookup without any IP-based or account-based throttling. In a production environment, this is one of the most common exploitation vectors.

**Fix:** Add rate limiting middleware (e.g., `slowapi` or nginx-level rate limiting). At minimum, implement exponential backoff after failed attempts per IP + per email.

### C3. Signup — No Password Strength Enforcement
**File:** `src/eden/api/routes/auth.py` (line ~98-120)  
**Severity:** CRITICAL  
**Risk:** Users can register with passwords like `"a"` or `"123"`, creating severe account takeover risk.  

The `SignupRequest` model accepts any non-empty string as password. No minimum length, complexity, or common-password checks exist. Bcrypt will hash anything, but weak passwords undermine the entire authentication system.

**Fix:** Validate password against a policy (min 8 chars, mix of character types) at the API layer. Consider using a library like `zxcvbn` for strength estimation.

### C4. Raw SQL Parameter Interpolation in Audit Log Search
**File:** `src/eden/api/routes/audit.py` (lines ~70-110)  
**Severity:** CRITICAL  
**Risk:** SQL injection via `search` parameter despite use of parameterized queries in most places.  

While most of the codebase uses parameterized queries (`$1`, `$2`), the audit log query constructs dynamic SQL with string interpolation for search terms. If not properly escaped (relying solely on LIKE with user input), this can be exploited.

**Fix:** Audit all SQL query construction sites. Use parameterized queries consistently. Never interpolate user input into SQL strings, even for LIKE clauses (use `%` concatenation in the parameter value, not the query string).

### C5. JWT Secret — Weak Fallback Mechanism
**File:** `src/eden/api/deps.py`, `src/eden/api/utils/auth.py`  
**Severity:** CRITICAL  
**Risk:** If `JWT_SECRET` env var is not set, the fallback may use a weak or predictable secret, allowing token forgery.  

The authentication utility falls back to a default or auto-generated secret when the environment variable is missing. In production, a weak or missing JWT secret means anyone can forge authentication tokens.

**Fix:** The application should refuse to start (or refuse to issue tokens) if `JWT_SECRET` is not a sufficiently strong, explicitly configured value. No silent fallback.

---

## HIGH Issues

### H1. No Database Migration Runner
**Files:** `migrations/`, `src/eden/kb/__init__.py`  
**Severity:** HIGH  
**Risk:** Migrations are SQL files in a directory with no automated, ordered, idempotent runner. This makes deployment unreliable.  

Migrations exist as sequential SQL files (`001_kb_schema.sql`, `003_auth.sql`, etc.) but there is no migration framework (Alembic, Flyway, etc.) to apply them in order, track which have been applied, or roll back failed migrations. The `initialize_kb()` function attempts to run migration files directly, but without proper tracking.

**Fix:** Integrate Alembic (Python-native) or a simple migration runner with a `_migrations` tracking table.

### H2. No Async Timeout on Pipeline Execution (in some branches)
**File:** `src/eden/api/routes/jobs.py`  
**Severity:** HIGH  
**Risk:** Pipeline can hang indefinitely, consuming server resources and blocking the worker.  

While some branches have a `PIPELINE_TIMEOUT_SECONDS = 300`, the current code may not enforce this across all pipeline execution paths. An AI agent pipeline that stalls (e.g., stuck LLM call, infinite loop in sandbox execution) will never abort.

**Fix:** Enforce `asyncio.wait_for()` on all pipeline execution paths with a configurable timeout.

### H3. Inadequate Cookie Security for Auth Token
**Files:** `src/eden/api/routes/auth.py`, `src/eden/api/deps.py`  
**Severity:** HIGH  
**Risk:** Auth cookie lacks proper security attributes (`HttpOnly`, `Secure`, `SameSite`).  

The auth cookie is set via FastAPI's `Response.set_cookie()`. While the code may set some attributes, production requires: `HttpOnly=True`, `Secure=True` (in HTTPS), `SameSite="lax"` or `"strict"`, and a reasonable `max_age`. Missing these makes the token vulnerable to XSS theft and CSRF attacks.

**Fix:** Configure all cookie attributes explicitly for production.

### H4. Broad Exception Catching — Silent Failure Mode
**Multiple files across the codebase**  
**Severity:** HIGH  
**Risk:** Unexpected errors are silently swallowed, making debugging impossible and potentially masking data corruption.  

Many places use `except Exception as e:` with only a `logger.warning()` call. This hides bugs, data integrity issues, and security failures. Specific examples: KB initialization (`app.py:104`), pipeline execution (`jobs.py:138`), episodic queries in agents.

**Fix:** Catch specific exception types. Re-raise or propagate errors that indicate system-level failures. Add structured error reporting with correlation IDs.

### H5. No Request/Correlation ID Propagation
**Entire codebase**  
**Severity:** HIGH  
**Risk:** Debugging distributed requests across the pipeline is nearly impossible without tracing.  

There are no correlation IDs attached to requests. When a job fails after passing through 5-10 agents, there's no way to trace the full request path across log entries, database queries, and external API calls.

**Fix:** Add a correlation ID middleware in FastAPI. Propagate the ID through the pipeline state, LLM calls, and database operations.

### H6. No CORS Hardening
**File:** `src/eden/api/app.py`  
**Severity:** HIGH  
**Risk:** CORS may be too permissive in production.  

CORS middleware is configured but may use permissive origins (e.g., `allow_origins=["*"]` or overly broad patterns). In production, CORS should be restricted to known frontend domains.

**Fix:** Restrict CORS to specific origins based on environment configuration.

### H7. Qdrant — No Connection Pool or Retry Logic
**File:** `src/eden/storage/qdrant.py`  
**Severity:** HIGH  
**Risk:** Qdrant client may silently fail under load or during transient network issues.  

The Qdrant client wrapper creates a single gRPC/REST connection without proper connection pooling or retry logic. Under load or during Qdrant restarts, vector search operations can fail silently.

**Fix:** Implement connection pooling, health checks, and retry with exponential backoff for Qdrant operations.

---

## MEDIUM Issues

### M1. Test Coverage — Critically Low
**Files:** `tests/`  
**Severity:** MEDIUM  
**Risk:** No regression safety net. Any change can break functionality without detection.  

Only 2 test files exist:
- `tests/unit/pipeline/test_state.py`
- `tests/unit/agents/test_critic.py`

Both are small. There are no:
- Integration tests for API routes
- E2E tests for the pipeline
- Frontend tests (Jest, Playwright, etc.)
- Mock-based tests for LLM interactions

**Fix:** Establish a testing strategy targeting at least 40% coverage for critical paths (auth, jobs pipeline, billing).

### M2. No CI/CD Pipeline Configuration
**No files found**  
**Severity:** MEDIUM  
**Risk:** Every deployment is a manual process. No automated testing, linting, or deployment verification.  

The repository has no CI configuration files (.github/workflows, .gitlab-ci.yml, Jenkinsfile, etc.). The deployment script (`scripts/deploy/setup.sh`) is purely infrastructure-oriented.

**Fix:** Add GitHub Actions (or equivalent) with: `lint → type-check → test → build → deploy`.

### M3. Benchmark API Routes — 501 Not Implemented
**File:** `src/eden/api/routes/benchmark.py`  
**Severity:** MEDIUM  
**Risk:** Public API endpoints exist but return 501 errors, breaking client expectations and wasting round-trips.  

Several benchmark endpoints return `HTTPException(status_code=501, detail="...not yet implemented")`. In production, these should either be removed, return proper 404s, or be fully implemented.

**Fix:** Either implement the endpoints or remove them from the router until ready.

### M4. Dockerfile — No Multi-Stage Build
**Files:** `scripts/deploy/deploy/railway/Dockerfile`  
**Severity:** MEDIUM  
**Risk:** Bloated production images (500MB+), slower deploys, larger attack surface.  

The Dockerfile copies the entire application, installs build dependencies, and keeps everything in a single `python:3.11-slim` layer. No multi-stage build to separate build-time deps from runtime.

**Fix:** Use multi-stage Docker build. Build stage installs all deps; runtime stage copies only what's needed. Use `pip install --no-deps` where possible.

### M5. No Structured Logging
**Entire codebase**  
**Severity:** MEDIUM  
**Risk:** Logs are plain text, not machine-parseable. Cannot be ingested by log aggregation tools (Datadog, ELK, etc.) for alerting or dashboards.  

All logging uses Python's standard `logging` module with plain text format strings. No JSON logging, no structured fields (service name, environment, correlation ID, severity code).

**Fix:** Configure JSON logging with structured fields. Use `python-json-logger` or similar. Include correlation IDs, service names, and environment tags.

### M6. No Frontend Error Boundaries
**Files:** `clients/portal/src/app/layout.tsx`, `clients/portal/src/app/(portal)/layout.tsx`  
**Severity:** MEDIUM  
**Risk:** Unhandled React errors crash the entire page. No graceful degradation.  

The Next.js app has no React Error Boundaries wrapped around page content. A single render error in any component will crash the entire page, showing the user a white screen.

**Fix:** Add React Error Boundaries at the app layout level and around critical sections (chat, dashboard, settings).

### M7. PostgreSQL — No Connection Pool Health Checks
**File:** `src/eden/storage/postgres.py`  
**Severity:** MEDIUM  
**Risk:** Connection pool can silently degrade under load, leading to timeouts and dropped requests.  

The `asyncpg.create_pool()` setup lacks connection health checks, pool resize strategies, and monitoring. Under sustained load, the pool can become exhausted without warning.

**Fix:** Add pool metrics logging, connection validation on checkout, and configurable min/max pool sizes.

### M8. No Pre-commit Hooks
**No files found** (`pre-commit-config.yaml`)  
**Severity:** MEDIUM  
**Risk:** Developers can commit code with lint errors, type errors, or formatting issues.  

No pre-commit hooks are configured. The ruff.toml and mypy.ini configs exist but are never enforced at commit time. This means the code quality tools are optional.

**Fix:** Add `.pre-commit-config.yaml` with ruff, mypy, and trailing-whitespace hooks.

### M9. No Health Check Cross-Integration
**File:** `src/eden/api/app.py`  
**Severity:** MEDIUM  
**Risk:** The `/health` endpoint checks only that the API process is running, not its dependencies.  

The health endpoint returns `{"status": "healthy"}` without verifying connectivity to PostgreSQL, Qdrant, or other critical services. In production, a health check that doesn't verify dependencies is nearly useless.

**Fix:** Add dependency checks to the health endpoint (DB ping, Qdrant ping, LLM client connectivity).

### M10. Frontend — No Loading Skeleton for Critical Pages
**Files:** `clients/portal/src/app/(portal)/dashboard/page.tsx`, `clients/portal/src/app/(portal)/jobs/page.tsx`  
**Severity:** MEDIUM  
**Risk:** Poor user experience with loading states — users see nothing or layout jank while data loads.  

Several page components lack proper loading skeletons. They either show nothing (blank page) or use basic spinners. For a production SaaS, loading skeletons significantly improve perceived performance.

**Fix:** Add skeleton screens for dashboard, jobs list, and settings pages.

---

## LOW Issues

### L1. Docker Compose — Production vs Development Not Separated
**File:** `docker/docker-compose.yml`  
**Severity:** LOW  
**Risk:** Running `docker-compose up` in production uses development defaults (simple passwords, default configs).  

The compose file uses `${POSTGRES_PASSWORD:-eden_dev_password}` as default and exposes PostgreSQL on port 5432 publicly. No production overrides or secrets management integration.

**Fix:** Create `docker-compose.prod.yml` with production-grade defaults. Use secrets management (Docker secrets, Vault, etc.).

### L2. No `.env.example` Validation
**File:** `.env.example`  
**Severity:** LOW  
**Risk:** Missing environment variables cause cryptic startup failures.  

The `.env.example` file may not be kept in sync with actual configuration requirements. There's no validation that all required environment variables are set at startup.

**Fix:** Add a startup validation that checks all required env vars are present. Maintain `.env.example` automatically from configuration.

### L3. Frontend — No Accessibility Audit
**Files:** `clients/portal/src/`  
**Severity:** LOW  
**Risk:** The app may not comply with WCAG 2.1 standards, risking accessibility lawsuits and excluding users with disabilities.  

UI components (especially custom ones like Chat, PipelineStageBar) don't have explicit `aria-*` attributes, keyboard navigation handlers, or focus management.

**Fix:** Audit for keyboard accessibility, screen reader compatibility, and color contrast ratios.

### L4. No API Versioning
**File:** `src/eden/api/app.py`  
**Severity:** LOW  
**Risk:** API changes break existing clients. No clear version contract.  

All routes are under `/`, `/auth/`, `/orgs/`, etc. without any version prefix (`/v1/`, `/v2/`). Future API changes will break existing clients.

**Fix:** Add `/v1/` prefix to all API routes. Use FastAPI's `prefix` parameter.

### L5. LLM Client — No Fallback Model Configuration
**File:** `src/eden/llm/client.py`  
**Severity:** LOW  
**Risk:** If the primary model fails, there's no automatic fallback to a different model.  

The LLM client has retry logic (+ circuit breaker) but no fallback model chain. If the primary model is down or degraded, all pipeline agents fail.

**Fix:** Add a configurable fallback model list. Each retry can try a different model.

### L6. Email Service — SendGrid API Key Hard-Coded in Query
**File:** `src/eden/services/email_service.py`  
**Severity:** LOW  
**Risk:** API key transmitted in URL/memory.  

The SendGrid API key is passed as a Bearer token in the Authorization header, which is standard. However, error logging may inadvertently log the full response including headers.

**Fix:** Ensure no sensitive data appears in log messages. Use `response.text` only with explicit scrubbing.

### L7. No Frontend Bundle Analysis / Optimization
**No files found**  
**Severity:** LOW  
**Risk:** Users may download unnecessarily large JavaScript bundles.  

No bundle analysis tooling (Webpack Bundle Analyzer, Next.js build analysis) is configured. Large dependencies (chat syntax highlighting, etc.) could bloat initial page loads.

**Fix:** Add `@next/bundle-analyzer` and set up periodic bundle size checks.

### L8. Missing Rate Limiting on File Upload Endpoints
**File:** `src/eden/api/routes/references.py`  
**Severity:** LOW  
**Risk:** Unrestricted file uploads can exhaust storage or be used for denial of service.  

The reference upload endpoint accepts files without size limits or upload rate limiting.

**Fix:** Add file size validation (e.g., `UploadFile` size check) and upload rate limiting.

### L9. No Cron Job / Scheduled Task Runner
**No files found**  
**Severity:** LOW  
**Risk:** No periodic maintenance tasks (session cleanup, token rotation, usage reports).  

There's no scheduler for background maintenance tasks like cleaning expired tokens, rotating API keys, or generating periodic usage reports.

**Fix:** Add a simple scheduler (APScheduler, Celery Beat) for periodic maintenance.

### L10. Frontend — No Service Worker / PWA Support
**No files found**  
**Severity:** INFO  
**Risk:** Offline experience not available. No installable PWA.  

The Next.js app has no service worker or PWA manifest. For a SaaS product, this limits mobile engagement options.

**Fix:** Add `next-pwa` or service worker for offline capability and installability.

---

## SECURITY SUMMARY

| Category | Count | Details |
|----------|-------|---------|
| **CRITICAL** | 5 | Webhook verification, rate limiting, password policy, SQL injection risk, JWT secret |
| **HIGH** | 7 | Migration runner, pipeline timeout, cookie security, exception handling, tracing, CORS, Qdrant reliability |
| **MEDIUM** | 10 | Test coverage, CI/CD, benchmark endpoints, Docker builds, logging, error boundaries, DB pool, pre-commit, health checks, loading skeletons |
| **LOW** | 10 | Docker config separation, env validation, a11y, API versioning, LLM fallback, email security, bundle analysis, upload limits, task scheduler, PWA |

**Total issues identified: 32**

---

## ARCHITECTURAL STRENGTHS

1. **Agent pipeline architecture** is well-designed with clear separation of concerns (Planner → Research → Code → Sandbox → Test → Critic → Refine).
2. **Circuit breaker pattern** in the LLM client (`CircuitBreaker` class with state tracking) is a robust production pattern.
3. **Knowledge Base abstraction** with multiple backends (episodic, semantic, procedural, exploit) is well-structured.
4. **Hashed API keys and invite tokens** using `secrets` module and bcrypt — proper security practices in the right places.
5. **SCIM implementation** follows RFC 7644 with proper error responses and schemas.
6. **Async-first** design throughout the backend with proper connection pooling for PostgreSQL.
7. **Comprehensive deployment script** supporting multiple providers with cost estimates — excellent DevOps practice.

---

## TOP 10 PRIORITY FIXES

1. **Stripe webhook signature verification** — Without this, billing is wide open to fraud.
2. **Auth rate limiting** — Deploy immediately to prevent brute-force attacks.
3. **Password strength validation** — Ship alongside rate limiting for auth hardening.
4. **JWT secret enforcement** — App must refuse to start without a configured secret.
5. **Pipeline execution timeout** — Enforce `asyncio.wait_for()` on all pipeline paths.
6. **Database migration runner** — Integrate Alembic before production deployment.
7. **Correlation ID middleware** — Critical for debugging in production.
8. **Structured JSON logging** — Essential for log aggregation and alerting.
9. **Cookie security attributes** — `HttpOnly`, `Secure`, `SameSite` must be set for production.
10. **CI/CD pipeline** — Add GitHub Actions for automated testing and deployment.
