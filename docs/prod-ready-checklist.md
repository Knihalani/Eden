# Eden — Prod-Ready Checklist

Two phases of work to get Eden to a launch-ready state. Each item is concrete enough to start on without further design.

## Phase 1 — Unblock Launch

These items gate launch. None are negotiable for an enterprise customer or a public launch.

### 1.1 Backend test failures (35 failing)

- **`webhook_delivery.py` — full rewrite**

  Module surface expected by tests:
  - `_assert_public_ip(url)` — SSRF guard. Rejects non-`https` schemes, missing hostnames, unresolvable hostnames, and any resolved IP that is private/loopback/link-local/multicast/reserved/unspecified. Error messages must match the regexes `"non-public"`, `"scheme"`, `"hostname"`, `"could not be resolved"`.
  - `WebhookTestResult` — pydantic `BaseModel` with fields `success: bool`, `http_status: int | None`, `response_body: str | None`, `error: str | None`.
  - `WebhookSigner.sign_v1(secret, payload, *, timestamp=None) -> str` — returns `f"t={ts},v1={hex}"` where `hex = HMAC_SHA256(secret, f"{ts}.{payload}".encode())`.
  - `WebhookSigner.verify_v1(secret, payload, header_value, *, tolerance_seconds=300) -> bool` — `hmac.compare_digest`, rejects stale timestamps.
  - `WebhookDeliveryService.deliver_event(event_id, org_id)` — fetch the row from `webhook_events`, call `_schedule_delivery`.
  - `WebhookDeliveryService.deliver_test(*, webhook_id, url, secret) -> WebhookTestResult` — synchronous, SSRF-guarded, returns the test result.
  - `WebhookDeliveryService.list_dlq(org_id, *, limit=50) -> list[dict]` — fetch from `webhook_dlq` for the org.
  - `WebhookDeliveryService.replay_dlq(dlq_id) -> dict` — on cap reached returns `{"status": "replay_cap_reached", "replay_count": 3, "max_replay_count": 3, ...}`; on gap too small returns `{"status": "replay_rate_limited", "seconds_since_last_replay": 5.0, "min_replay_gap_seconds": 60, ...}`; happy path returns `{"status": "ok", "dlq_id": "...", "replay_count": 1, "max_replay_count": 3}`; missing row returns `{"status": "not_found", "dlq_id": "..."}`.
  - `WebhookDeliveryService.drain(timeout=30.0) -> int` — returns `0` when all in-flight tasks complete within budget; returns count of stuck tasks on timeout.
  - `WebhookDeliveryService._schedule_delivery(*, delivery_id, url, secret, payload) -> asyncio.Task` — spawns the attempt task, adds to `self._in_flight`, returns the task.
  - `WebhookDeliveryService._attempt_delivery(*, delivery_id, url, secret, payload)` —
    - First SQL is a single atomic CAS: `UPDATE webhook_deliveries SET status='in_flight', last_attempt_at=NOW() WHERE id=$1 AND status IN ('pending','retrying') RETURNING attempt_count, max_attempts, webhook_id`. If `RETURNING` yields nothing, return silently.
    - Calls `_assert_public_ip(url)` BEFORE any HTTP. On `ValueError`: `UPDATE webhook_deliveries SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1` where `$2` contains the substring `"SSRF guard"`, then call `_move_to_dlq`. Do **not** instantiate `httpx.AsyncClient`.
    - On success (2xx): `UPDATE webhook_deliveries SET status='succeeded', response_status=$2, attempt_count=$3, completed_at=NOW() WHERE id=$1`.
    - On failure: increment `attempt_count`, schedule the next attempt via `asyncio.get_event_loop().call_later(delay, ...)`. The function body MUST NOT contain `await asyncio.sleep` as executable code.
    - When `attempt_count >= max_attempts`: mark `failed`, call `_move_to_dlq`.
  - `WebhookDeliveryService._move_to_dlq(delivery_id, *, webhook_id)` — inserts into `webhook_dlq` from a `SELECT` against `webhook_deliveries`. On any exception, log at `ERROR` with `delivery_id=` in the message. Does NOT raise.

- **LLM gateway — finish DL-15 / DL-10**
  - `JudgeScore.cost_usd: float = 0.0` default.
  - `JudgeScore.to_dict()` includes `"cost_usd"` key.
  - Persist path writes the `cost_usd` column in `judge_scores`.
  - `settings.gateway_max_tokens_cap: int = 4096` (DL-10).
  - `AIGateway._execute_provider` raises `ValueError` when `request.max_tokens > gateway_max_tokens_cap` AND when `request.max_completion_tokens > gateway_max_tokens_cap` — match either field name the test uses.

- **Other backend tests (~19)**
  - Run `pytest tests/unit tests/intelligence tests/api --tb=short -q`.
  - Triage each failure: datetime, async/sync, schema drift, migration head, fixture mismatch.
  - Reach 0 failures across all unit + intelligence + api test paths.

### 1.2 Cat 23 (Autonomous Code Modification) audit

- `grep -rn "_not_implemented_envelope\|_error_envelope" src/eden/code_change/` — for each hit, read the method.
- For methods reachable from a route: implement real logic or remove the route.
- For unreachable methods: delete the file.
- Verify the 24 Cat 23 routes return real data, not stub envelopes. Spot-check by reading each route handler.
- Confirm Cat 23 migrations apply clean and tables/indexes exist.
- Add ONE end-to-end integration test: `patch_generator → inbox/review (approve) → test_runner → pr_creator` against a tiny patch fixture.

### 1.3 Backend code-quality sweep

- Sweep `src/eden/**/*.py` for `datetime.utcnow(` — replace with `datetime.now(UTC)`; bump imports.
- Run `mypy src/eden/`; fix every type error (do not relax the config).
- Sweep `src/eden/` for bare `pass` inside `except:` — replace with `logger.warning(...)` at minimum.
- `ruff check src/eden/ --select F401,F841` — fix unused imports and unused variables.
- Sweep `src/eden/` for `_not_implemented_envelope` / `_error_envelope` / `"TODO"` / `"FIXME"` — for every hit, implement or remove.
- Sweep coroutines: `grep -rn "create_task\|gather\|ensure_future" src/eden/` — verify each call is awaited where required.
- `alembic upgrade head` from a fresh DB; verify the chain applies clean and the head is the expected revision.
- Confirm all 698 routes still boot after the sweep.

### 1.4 Security audit

- **Authn on every route**: every POST/PUT/PATCH/DELETE handler must depend on `get_current_user` (or equivalent). Find violations with: `grep -rn "@router\.\(post\|put\|patch\|delete\)" src/eden/api/routes/` and cross-check each handler.
- **Authz on every route**: every org-scoped route must verify the requesting user is a member of `org_id` (or is admin). Spot-check 10–20 routes manually.
- **Rate limits**: B-11 (per-(org,user) create 5/h) exists; verify every state-changing endpoint has *some* limit, or document why one is unnecessary.
- **API keys**: `psql ... SELECT column_name FROM information_schema.columns WHERE table_name='api_keys'` — confirm `key_hash` exists and no plaintext `key` column.
- **PII in logs**: `grep -rn "logger\.\(info\|debug\|warning\).*\(email\|password\|token\|secret\|api_key\)" src/eden/` — redact each hit.
- **XSS**: `grep -rn "dangerouslySetInnerHTML\|innerHTML" clients/portal/src/` — review each, ensure sanitization or document why the input is trusted.
- **CORS, CSP, HSTS**: read every middleware in `src/eden/api/middleware/` — confirm production origins only, CSP header set, HSTS header set, Referrer-Policy set.
- **Dependency audit**: `pip-audit -r requirements.txt` and `cd clients/portal && npm audit` — fix every high/critical; medium may be tracked.
- **Permission tests**: add `tests/security/test_cross_user_access.py` with a matrix — for each major resource type (org, agent, webhook, dataset, run), assert user X cannot read/modify user Y's resource and a non-member cannot read/modify org Z's resource.
- **Static analysis**: run `semgrep` if configured in `.semgrep/`; review findings.

### 1.5 Compliance endpoints (legal gate)

These MUST exist before signing enterprise customers:

- `GET /api/v1/me/data` — exports all data the current user/org has stored. Returns a job ID; the job writes a signed URL to S3 and emails when ready.
- `DELETE /api/v1/me` — hard-delete user account. Cascades to org memberships (or marks them closed). Soft-delete the user row for fraud-prevention retention per the privacy policy.
- `DELETE /api/v1/orgs/{org}/data` — org-level deletion for offboarding.
- `POST /api/v1/dsar` — Data Subject Access Request form intake; creates a tracked ticket that ops can act on within the SLA.
- Cookie consent banner in `clients/portal/src/app/layout.tsx` — gate analytics, marketing tags, and preference storage behind explicit consent. Reject non-essential cookies until consent is given.
- `GET /subprocessors` — public list of sub-processors (Postgres host, Redis host, OpenRouter/Anthropic/OpenAI, S3, email provider, error tracker) with last-updated date. Required by GDPR Art. 28.
- "Do Not Sell My Personal Information" link in the marketing footer for CCPA.
- Legal review of `/privacy`, `/terms`, `/dpa`, `/security` — leave `// TODO: legal review` markers visible.

## Phase 2 — Polish

### 2.1 Frontend UI — 75 pages remaining

Polish checklist applied to every page:
1. Replace generic shadcn defaults with category-specific iconography (Lucide icons chosen for the actual concept, not the input/output shape).
2. Empty states: contextual illustration + action verb + one-line value prop.
3. Loading states: skeleton that matches the final layout's grid; no spinner on data fetches.
4. Error states: inline `Alert` with retry; no full-page reload.
5. Keyboard nav: every interactive element reachable via Tab; focus ring visible; `Esc` closes modals.
6. ARIA: `aria-label` on icon buttons, `aria-live="polite"` on toasts, `role` on dialogs, focus trap on modals.
7. Responsive: tested at 375, 768, 1024, 1440, 1920.
8. No "TODO" / "Coming soon" / placeholder copy in customer-visible text.
9. Dark mode parity (toggle and verify every page reads correctly).
10. No `console.log` / `debugger` left in production build.

Pages to polish:

**Observability (12)**
- `observability/page` — Langfuse-style token + cost cards on the right rail; trace table with virtualized scroll; span tree on click.
- `observability/apm` — Datadog-style insights at the top; latency percentiles; error-budget burn-down; service map.
- `observability/cohorts` — Amplitude-style cohort grid with retention matrix.
- `observability/decisions` — Honeycomb-style bubble histogram with drill-down.
- `observability/eval` — LangSmith-style run comparison table with side-by-side diff.
- `observability/insights` — Brain iconography, prioritized list with severity bars, action buttons.
- `observability/query` — Splunk-style query bar with time-range, syntax highlighting, saved queries.
- `observability/retrieval` — chunk-level attribution waterfall, top-K heatmap.
- `observability/time-travel` — GitLab-style timeline scrubber with diff side-by-side.
- `observability/inspector` — debug tree with payload + headers + timing.
- `observability/marketplace` — Vercel-template card grid with install counts.
- `observability/multi-agent` — agent graph with edge labels, cost-per-edge.

**Auth (7)**
- `signup` — Vercel-style progressive disclosure (one field per step), Clerk-style social buttons.
- `forgot-password`, `verify-email` — Linear-style OTP input (six-digit, paste support).
- `accept-invitation` — clear org context, "Join as [role]" CTA.
- `onboarding/install` — SDK snippets with copy buttons, language tabs (py/ts/rust), working curl example.
- `onboarding/_steps/autonomous`, `_steps/wait` — animated progress, time-remaining estimate, "skip for now."

**Account (3)**
- `settings` — Linear-style vertical sidebar with sections, save-on-blur, optimistic UI.
- `teams` — Stripe-style member table, role badges with hover descriptions.
- `billing-history` — Stripe-style invoice list with PDF download.

**LLMOps / Labels / Incidents (3)**
- `llmops` — split-pane (run list left, trace right), keyboard `/` to filter.
- `labeling` — Labelbox-style label queue with keyboard shortcuts (1–5 for labels), auto-advance.
- `incidents` — PagerDuty-style timeline with severity colors, on-call assignment visible.

**Marketing (8)**
- `/` (homepage) — bold hero, working product screenshot (not stock illustration), social proof, three-tier pricing.
- `/pricing` — Stripe-style monthly/yearly toggle, three plans, "Most popular" highlight, FAQ.
- `/about` — team with real photos, values, investors.
- `/contact` — structured fields (use case, company size), not just email.
- `/blog/[slug]` — long-form with TOC sidebar, reading progress bar.
- `/changelog` — "What's new" vs "Fixed" sections, dates, screenshots.
- `/customers` — case-study cards with metric headlines.
- `/careers` — open roles with department/location filters.

**Error / empty states (4)**
- `not-found` — branded 404 with "Go home" + "Contact support" + suggested links based on route.
- `error` — branded 500 with trace ID + "Report this" button.
- `loading` — branded skeleton, never blank.
- `offline` — detect `navigator.onLine`, show cached last view.

**Detail pages (6)**
- `agents/[id]`, `builder/[id]` — Vercel deployment-density layout, tabs for versions/runs/logs.
- `run-results`, `run-detail` — Diff-style left/right for trace comparisons, timeline scrubber.
- `marketplace/[id]` — install modal with permissions preview, "Used by N orgs."
- `integrations` — Slack/Discord/PagerDuty-style cards with one-click connect.

### 2.2 Frontend global UI

- **Cmd+K palette** — `cmdk`-based; index routes + recent items + command actions (sign out, invite team, switch org).
- **Unified toast system** — pick one (sonner or react-hot-toast); remove the others; replace every `alert()`.
- **Error boundaries** — `<ErrorBoundary>` around each route group in `app/(portal)/layout.tsx`; show branded fallback.
- **Analytics events** — PostHog or Plausible; track page view, sign-up, install SDK, create webhook, first trace.
- **Cookie consent banner** — see Phase 1.5.
- **Dark mode toggle** — in settings; persist to localStorage; verify all 86 pages.
- **i18n** — `next-intl` setup with `en` + at least one of `de`/`ja`; toggle in footer.
- **Sitemap** — `app/sitemap.ts` generates `/sitemap.xml` from the route map.
- **Robots** — `app/robots.ts` allows marketing, disallows portal/api.
- **Meta tags** — `generateMetadata` for Open Graph + Twitter cards on every page; canonical URLs.

### 2.3 Documentation

- **Architecture diagram** — Mermaid in `docs/architecture.md`: Portal (Next.js) → API (FastAPI) → {Postgres, Redis, ClickHouse, S3, OTel}; arrows for auth, telemetry ingestion, judge pipeline, webhook delivery, budget gate, memory pipeline.
- **Data flow diagrams** — `docs/data-flow.md`: trace ingest → judge → dashboard; webhook → delivery → DLQ; budget gate → record_usage → hard-limit block; memory ingest → retrieval → injection.
- **API docs site** — Mintlify or Read the Docs; auto-generate from OpenAPI; deploy to `/docs`.
- **Customer quickstart** — `docs/quickstart.md`: install → first trace → first dashboard.
- **CHANGELOG.md** — one line per shipped change with link to commits.
- **Internal runbooks** — write the missing six: API down, DB down, Redis down, webhook delivery backlog, budget exceeded, judge cascade.
- **MIGRATION.md** — `alembic upgrade head` from scratch; `alembic downgrade -1` rollback tested.
- **TROUBLESHOOTING.md** — top 10 errors with log excerpts and fixes.
- **SECURITY.md** — responsible disclosure policy with email + 90-day SLA.
- **CONTRIBUTING.md** — local dev setup; test, lint, type-check commands; PR template.

### 2.4 Accessibility (legal gate)

- Run `npx @axe-core/cli` against the top 20 pages; fix every `critical` and `serious` finding.
- Manual keyboard nav pass: tab through `signup → /portal → /portal/settings → /portal/observability → /portal/billing`; record any focus-trap bugs.
- Color contrast sweep: bump any `text-gray-4` / `text-zinc-4` (and equivalents) that fail WCAG AA (4.5:1).
- Verify focus indicators visible on all 75 pages.
- Verify mobile responsive at 375px (iPhone SE), 768px (iPad), 1024px (laptop), 1440px (desktop), 1920px (large).
- Screen-reader smoke test with VoiceOver on `/`, `/portal`, `/portal/observability`, `/portal/billing`.
- Add `prefers-reduced-motion` handling in all animation CSS.
- Verify form labels are associated; add `aria-describedby` for help text; add `aria-invalid` for errors.
- Verify skip-to-content link on every page.
