# Troubleshooting

Top 10 errors with log excerpts and fixes.

## 1. `pydantic.ValidationError: 1 validation error for ChatCompletionRequest — max_tokens exceeds gateway_max_tokens_cap`

**Cause:** Caller's `max_tokens > 4096` (the default cap).
**Fix:** Lower `max_tokens` on the request, or set `GATEWAY_MAX_TOKENS_CAP=0` in env (unlimited) for enterprise plans.

```
# logs
2026-07-02T12:34:56Z ERROR gateway max_tokens=100000 exceeds gateway_max_tokens_cap (4096); lower max_tokens or raise the cap
```

## 2. `SSRF guard rejected URL http://10.0.0.1/hook`

**Cause:** The webhook URL resolves to a private/loopback/link-local IP. SSRF guard (`_assert_public_ip`) blocks it.
**Fix:** Webhook URL must be a public HTTPS endpoint. Use ngrok for local testing.

## 3. `405 Method Not Allowed` on POST `/api/v1/me/data`

**Cause:** The endpoint only accepts GET.
**Fix:** Use `GET /api/v1/me/data` to start a data export.

## 4. `403 Not a member of this organization`

**Cause:** Caller's user_id is not a member of the org_id in the path.
**Fix:** Check `org_members` table — the user must be added to the org first (invitation flow).

## 5. `429 Budget exceeded`

**Cause:** Org's `org_budgets.current_usd` > `hard_limit_usd`.
**Fix:**
* Increase the budget in `/portal/settings/budget`.
* Or, in an emergency, pause budget enforcement via the budget kill-switch runbook.

## 6. `JWT decode failed: Signature verification failed`

**Cause:** The Clerk secret key changed without a JWKS refresh.
**Fix:** Wait 60s — the JWKS auto-refreshes on `kid` miss. If it persists, restart the API.

## 7. `columnar query failed: reference to disallowed table 'organizations'`

**Cause:** The B-17 pg-fallback table allowlist excludes anything outside
`telemetry_events`, `usage_events`, `judge_scores`.
**Fix:** Issue the query against the dashboard endpoints (which use the v1.3 rollup path), not the raw SQL endpoint.

## 8. `Alembic upgrade head fails: relation "judge_scores" already exists`

**Cause:** Migration chain drift — a previous migration was applied but not recorded in `alembic_version`.
**Fix:**
```bash
# Identify the head we should be on
alembic heads
# Stamp the DB at the correct revision
alembic stamp <revision>
```

## 9. `cors_origin_not_allowed`

**Cause:** Caller's origin is not in `CORS_ORIGINS_RAW`.
**Fix:** Add the origin to the CSV (e.g. `https://staging.example.com`) in
Northflank secrets + redeploy.

## 10. `Redis: Connection refused`

**Cause:** Redis is down (or `REDIS_URL` secret rotated without restart).
**Fix:** See `docs/runbooks/redis-down.md`. Verify the URL in Northflank secrets.

## Getting more help

* Runbooks: `docs/runbooks/`
* Architecture: `docs/architecture.md`
* Data flow: `docs/data-flow.md`
* API reference: `/portal/docs` (auto-generated from OpenAPI)
* Status: <https://status.edenobservability.com>
* Support: <support@edenobservability.com>
