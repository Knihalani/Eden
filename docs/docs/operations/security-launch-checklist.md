# Security launch checklist

> Pre-launch gate for cloud SaaS and self-hosted GA. Complete every
> item and attach evidence links before flipping production DNS.
>
> Related: [Security overview](/operations/security),
> [SOC 2 control mapping](/operations/soc2-control-mapping)

## Authentication & secrets

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 1 | `JWT_SECRET` is not a placeholder in production | Deploy env audit; `tests/unit/config/test_jwt_secret_assertion.py` passes in CI | CI log / Northflank secret name |
| 2 | `ENCRYPTION_KEY` is unique per environment | Fernet key generated per env; not copied from `.env.example` | Secret manager screenshot (redacted) |
| 3 | API keys rotatable from portal | Settings → API Keys: create, use, revoke | Screen recording or E2E |
| 4 | MCP keys documented | Settings → MCP tab shows config; dedicated `POST /v1/mcp/keys` when `eden_mcp_server_v1` enabled | Portal + docs link |

## Authorization & audit

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 5 | RBAC audit clean | `python -m eden.audit.rbac_audit` — no orphan permissions | Command output saved to release ticket |
| 6 | Audit log hash chain | `GET /orgs/{id}/audit-log/verify` returns valid | curl output |
| 7 | Autonomy policy visible | Settings → Autonomous explains T0–T4 tiers | Portal screenshot |
| 8 | Every autonomous action logged | Closed-loop orchestrator writes audit events | Sample audit log entry |

## Data protection

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 9 | PII redaction default-on | Gateway + SDK `redact_on_client` enabled by default | Config snapshot |
| 10 | Fixture export redacts PII | Export fixture from issue; no raw emails/phones | Sample fixture JSON |
| 11 | Tenant isolation | Cross-org API call returns 403 | Integration test |
| 12 | TLS 1.3 on public endpoints | SSL Labs scan or `openssl s_client` | Scan report |

## Webhooks & rate limits

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 13 | Webhook HMAC signatures | Send test webhook; verify signature header | Webhook delivery log |
| 14 | Webhook DLQ replay UI | Settings → Webhooks DLQ shows failed deliveries | Portal screenshot |
| 15 | Rate limits active | 429 after per-tenant budget exceeded | Load test or manual burst |
| 16 | Budget kill switch | `budget_service` blocks ingest when cap hit | Test org over limit |

## Infrastructure

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 17 | Postgres backups running | CronJob or `scripts/dr_drill.sh` restore succeeds | DR drill JSON report |
| 18 | `/health` wired to LB | External health check returns `healthy` | LB config |
| 19 | Helm smoke test passed | [Deploy guide — Helm smoke test](/how-to/deploy#helm-smoke-test-kind--minikube) | Checklist in release ticket |
| 20 | Rollback window documented | 5-day Fly.io rollback noted in cutover runbook | `docs/deploy/cutover-checklist.md` link |

## Legal & compliance

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 21 | Terms of service counsel-reviewed | Legal sign-off on `/terms` | Email / ticket |
| 22 | Privacy policy counsel-reviewed | Legal sign-off on `/privacy` | Email / ticket |
| 23 | Security page published | `/security` matches `docs/operations/security.md` | URL live |
| 24 | DPA available | Enterprise DPA template on request | Sales asset link |
| 25 | SOC 2 control matrix current | `soc2-control-mapping.md` updated for launch features | PR link |

## SDK distribution

| # | Item | How to verify | Evidence |
|---|------|---------------|----------|
| 26 | `eden-sdk` 0.3.0 on PyPI | `pip install eden-sdk==0.3.0` + doctor green | PyPI page |
| 27 | `@eden-ai/sdk` 0.3.0 on npm | `npm i @eden-ai/sdk@0.3.0` + doctor green | npm page |
| 28 | Docs quickstart accurate | TS uses `detectInstalledFrameworks` + `wrap*`; doctor step present | Docs PR |
| 29 | MCP Cursor config works | Copy from Settings → MCP; smoke `search_traces` | Cursor screenshot |

## SLA verification (staging)

| SLA | Target | Verified |
|-----|--------|----------|
| Issue after trace | p95 < 60 s | [ ] |
| MCP read tool | p95 < 800 ms | [ ] |
| Portal issues list | p95 < 300 ms | [ ] |
| StatGate P0 | < 200 ms | [ ] |
| Typesense search | p95 < 200 ms | [ ] |

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering lead | | | |
| Security | | | |
| Legal / compliance | | | |
| Product | | | |
