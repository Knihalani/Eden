# Ingest auth harden — prod deploy notes (Wave 2 → Wave 3)

**Status:** Fixes verified in working tree; **not yet on production** (`api.edenobservability.com`).

Live evidence (pre-deploy): `clients/portal/e2e/golden/w2-08-live-ingest-matrix.json`

| Probe | Prod today | Expected after ship |
| --- | --- | --- |
| `POST …/ingest/openai` + bad key + `X-Org-Id` | **500** | **401** |
| `POST …/ingest/openai` + non-UUID `X-Org-Id` | **500** | **401** |
| `POST …/observability/telemetry/ingest` + bad key | **403** “Not a member” | **401** |
| Malformed key / missing key | mixed | **401** |
| True Postgres outage during key lookup | may 500 | **503** + `Retry-After: 5` |

---

## What must ship

### Service (required)

| Platform | Service / deployable | Notes |
| --- | --- | --- |
| **Northflank** | `eden-api` | FastAPI app that mounts `ingestion` + `observability.ingest_router`. This is the **only** service that must redeploy for the auth status-code fixes. |
| **Northflank** | `eden-worker` / cron jobs | **Not required** for this ship — they do not run `get_current_org_api_key` / ingest routes. |
| **Vercel** | portal (`clients/portal`) | **Not required** for auth status codes. Redeploy only if you also want the Wave-1 `list_traces` 503 UX (portal already treats non-2xx as error; soft-empty was a backend lie). |

No new env vars. No Alembic migration. No Redis/ClickHouse/Qdrant config change.

### Code surfaces included in the ship

1. `src/eden/api/deps.py` — `get_current_org_api_key`:
   - `oak.org_id::text = $2` (stops non-UUID → asyncpg 500)
   - UUID-syntax faults → **401**; other DB faults → **503**
   - auth dict includes both `key_id` and `api_key_id`
2. `src/eden/api/routes/api_keys.py` — same `org_id::text` + `api_key_id` on validate path (keep in sync)
3. `src/eden/api/routes/observability.py` — `ingest_router` telemetry endpoints use `Depends(get_ingest_auth)` (not `require_path_org_access`)
4. `src/eden/api/routes/ingestion.py` — multi-format ingest already on `get_ingest_auth`; gzip gunzip + `api_key_id`/`key_id` attribution intact
5. `src/eden/api/routes/observability.py` — `list_traces` PG miss/failure → **503** (no soft-empty)

### Env the API already needs (no change)

Runtime still needs the usual Postgres pool vars on `eden-api` (`POSTGRES_*` / secret group `eden-required`). Auth lookup hits `org_api_keys` + `organizations` — if Postgres is down, callers correctly get **503**, not a silent empty traces list.

SDK / curl callers continue to send:

- `X-Org-Id: <eden org uuid>`
- `X-Org-Api-Key: sk_eden_…`
- Path org must match authenticated org

---

## Deploy steps (Northflank)

1. Merge / push the Wave-2+3 commit set that contains the files above.
2. Redeploy **only** `eden-api` (Northflank: rebuild from the new image / commit).
3. Confirm boot: `/live` 200, `/ready` healthy Postgres.
4. Smoke (replace host / org):

```bash
# Expect 401 (not 500)
curl -sS -o /tmp/out -w "%{http_code}" \
  -X POST "https://api.edenobservability.com/orgs/org_clerk_style/ingest/openai" \
  -H "Content-Type: application/json" \
  -H "X-Org-Id: org_clerk_style" \
  -H "X-Org-Api-Key: sk_bad_key_0000" \
  -d '{}'

# Expect 401 (not 403 Not a member)
curl -sS -o /tmp/out -w "%{http_code}" \
  -X POST "https://api.edenobservability.com/orgs/<uuid>/observability/telemetry/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Org-Id: <uuid>" \
  -H "X-Org-Api-Key: sk_bad_key_0000" \
  -d '{"event_id":"e","project_id":"default","trace_id":"t","realm":"environment","event_type":"llm.completion","timestamp":"2026-07-20T00:00:00Z"}'
```

5. Optional: re-run the live matrix script that wrote `w2-08-live-ingest-matrix.json` and confirm `pass: true` on the previously failing negative probes.

---

## Remaining prod gaps (after this ship)

| Gap | Owner | Notes |
| --- | --- | --- |
| Positive ingest path still needs real `EDEN_ORG_ID` + `EDEN_ORG_API_KEY` in the probe env | Ops / QA | Matrix marked `BLOCKED_NEEDS_KEYS` |
| `/orgs/{org}/ingest/custom` not registered | Product | 404 in OpenAPI — use `/ingest/framework` or telemetry ingest |
| Soft deps (e.g. Qdrant) may still make `/health` **503 degraded** | Infra | Unrelated to ingest auth; do not block this ship on Qdrant |
| Portal golden e2e still needs seeded auth for hub routes | Portal / W2-07 | Separate from API auth status codes |

---

## Rollback

Redeploy previous `eden-api` image. No schema rollback. Clients that learned **401** will again see **500** / **403** on bad keys until re-fixed.
