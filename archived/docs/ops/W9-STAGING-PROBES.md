# W9 Staging Probes (operator runbook)

**Scripts:**  
- `bash scripts/w9_staging_probes.sh` — unit + Helm + optional live HTTP  
- `bash scripts/w9_local_probes.sh` — local HTTP stubs (+ docker compose Typesense when daemon up)

**Date baseline:** 2026-07-17 (local mode added same day)

## What is GREEN in-repo

| Contract | Evidence |
|---|---|
| Leader lock fail-closed | `Lock.acquire()` returns `False` when Redis is `None` — `tests/unit/platform/test_w9_platform.py` |
| Ingest shed | Depth over threshold → HTTP 429 — same suite |
| Late-span policy | Reject / soft-stamp by event age — same suite |
| RTBF fanout honesty | Unavailable/failed surfaces visibly — W9 suite + RTBF routes |
| Helm API probes | `livenessProbe` `/live`, `readinessProbe` `/ready` |
| Helm worker probe | `exec` process check in `worker-deployment.yaml` |
| Helm HPA / PDB / Secrets | Chart templates under `helm/eden/templates/` |
| F84 heartbeats / flags / `eden_health` | Shipped; MCP smoke via `scripts/w29_mcp_smoke.sh` |
| Local HTTP probe contracts | `w9_local_probes.sh` → 16 PASS / 0 FAIL / 1 SKIP (Typesense) |

## Local mode (no staging URLs)

```bash
bash scripts/w9_local_probes.sh
```

Stands up ephemeral `/live` `/ready` `/health` + portal-root stubs, then runs the same
`w9_staging_probes.sh` curl contracts against `127.0.0.1`. If Docker is healthy and
`TYPESENSE_API_KEY` is in `.env`, also `docker compose -f docker/docker-compose.yml up -d typesense redis`.

**Honesty:** local stubs prove probe wiring, not staging dogfood. Wave stays **PARTIAL**
until staging URLs pass or a real compose stack (API+portal+Typesense) is green.

## Operator-gated staging

```bash
export EDEN_STAGING_API_URL=https://api.<your-staging>
export EDEN_STAGING_PORTAL_URL=https://portal.<your-staging>
# Optional NF Typesense:
export TYPESENSE_HOST=...
export TYPESENSE_API_KEY=...
bash scripts/w9_staging_probes.sh
```

Without those env vars the script **SKIPs** live HTTP/Typesense checks and still validates unit + Helm contracts.

## Related

- `docs/ops/STAGING-VALIDATION.md` — broader local validation
- `docs/ops/typesense-clickhouse-external.md` — Typesense lag = event age
- `.github/workflows/dr-drill.yml` — DR advisory without backup bucket
