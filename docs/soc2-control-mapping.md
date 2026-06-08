# SOC 2 Trust Services Criteria — Eden control mapping

> **Owner:** Security & Compliance
> **Review cadence:** monthly (see `docs/runbooks/security-training.md`)
> **Status:** partial — see [§9.1.2 of the roadmap](./eden-development-roadmap.md) for the live status.
> **Source:** SOC 2 Type II — Trust Services Criteria (2017, updated 2022).

This document maps every SOC 2 criterion to (a) the Eden component
that implements the control and (b) the evidence we collect. The
"evidence location" column is what an external auditor would ask
for during a Type II engagement.

| # | Trust Criterion | Eden Component | Control Description | Evidence Location |
|---|-----------------|----------------|---------------------|-------------------|
| CC1.1 | Control environment — commitment to integrity | All-hands, code of conduct | Code of conduct signed by every engineer; ethics training | `docs/CODE_OF_CONDUCT.md` (to be added) + HRIS training records |
| CC1.4 | Background checks | HR onboarding | Background check completed before access to prod | HRIS records (out of Eden scope) |
| CC2.1 | Information & communication | Org-scoped RBAC + audit log | All cross-org data is blocked at the API layer | `src/eden/api/deps.py:get_current_org` + `migrations/020_rbac_custom_roles.sql` |
| CC2.2 | Internal communication | Status page + on-call rotation | Incident updates posted to status page within 15 min | Status page log |
| CC2.3 | External communication | Customer support + privacy@ inbox | Customer-impacting incidents emailed to all affected orgs | Email log + `docs/runbooks/security-training.md` |
| CC3.1 | Risk assessment | Risk register (`docs/`) | Quarterly risk review meeting | `eden-development-roadmap.md` §11 |
| CC3.2 | Fraud risk | AI gateway cost controls + anomaly alerts | `cost_tracking` alarms when daily spend > 3x 30-day median | `src/eden/optimization/cost_tracker.py` + `src/eden/observability/alerts.py` |
| CC4.1 | Monitoring activities | Telemetry + observability | All jobs emit `telemetry_events` rows; an anomaly detector runs nightly | `src/eden/observability/telemetry_collector.py` + `docs/runbooks/kb-audit.md` |
| CC5.1 | Control activities — selection & development | Code review + CI | Every PR requires 2 approvals + green CI | `docs/BRANCH_PROTECTION.md` |
| CC5.2 | Technology controls | DB migration runner + structured logging | Alembic tracks migrations; logs are JSON with correlation IDs | `src/eden/db_migrations/` + `src/eden/api/middleware/correlation_id.py` |
| CC5.3 | Deploy controls | Canary + auto-rollback | Production deploys are canary; auto-rollback on error-rate spike | `.eden/canary/` |
| CC6.1 | Logical access — identification & authentication | JWT + 2FA | 2FA required for org-owner role; rate-limited login | `src/eden/api/routes/auth.py` + `migrations/012_org_2fa_enforcement.sql` |
| CC6.2 | New user provisioning | SCIM + invite flow | Auto-provisioning via SCIM; invite flow for manual | `src/eden/api/routes/scim.py` (789 lines) + `src/eden/api/routes/orgs.py` |
| CC6.3 | Access removal | SCIM deprovisioning | User deprovisioned on IdP-side disable; tested in staging | `src/eden/api/routes/scim.py` DELETE flow |
| CC6.6 | External boundaries | Network policies + sandbox | Firecracker microVM per job; no shared network | `src/eden/sandbox/runner.py` |
| CC6.7 | Data in transit | TLS-only | TLS 1.2+ enforced at the LB; HSTS headers | LB config (out of Eden scope) |
| CC6.8 | Data at rest — prevention of unauthorized access | Encrypted secrets | All secrets encrypted at rest with Fernet (ENCRYPTION_KEY) | `src/eden/api/utils/encryption.py` |
| CC7.1 | System operations — vulnerability management | `safety` + `dependabot` | Weekly CVE scan; dependabot weekly | `.github/workflows/main.yml` security-scan job + `.github/dependabot.yml` |
| CC7.2 | Anomaly detection | Alerts engine | API p95 > 500ms / LLM error rate > 0.5% / pipeline timeout > 5% | `src/eden/observability/alerts.py` |
| CC7.3 | Incident response | Runbook | Documented IR runbook with severity tiers | `docs/runbooks/disaster-recovery-drill.md` |
| CC7.4 | Incident recovery | DR drill | Quarterly restore-from-backup drill | `docs/runbooks/disaster-recovery-drill.md` + `docker/postgres/restore.sh` |
| CC7.5 | Recovery testing | DR drill | See CC7.4 | Same |
| CC8.1 | Change management | PR review + 2 approvals | Branch protection enforces 2 reviewers + green CI | `docs/BRANCH_PROTECTION.md` + `.github/CODEOWNERS` |
| CC9.1 | Risk mitigation | Monitoring + alerts + DR | The §11 risk register is reviewed quarterly | `eden-development-roadmap.md` §11 |
| CC9.2 | Vendor & business partner risks | Vendor list | Annual vendor risk review | Procurement records (out of Eden scope) |
| A1.1 | Availability — capacity | Horizontal scaling | Stateless services; auto-scale group | K8s config (out of Eden scope) |
| A1.2 | Environmental protections | Multi-region (planned) | Data residency for EU/US/Asia | `eden-development-roadmap.md` §6.5 (planned) |
| A1.3 | Recovery — backup | `pg_dump` nightly | Daily `pg_dump` to S3 | `docker/postgres/backup.sh` |
| C1.1 | Confidentiality — access restrictions | RBAC + tenant scoping | Every request scoped to a single org via `get_current_org` | `src/eden/api/deps.py:get_current_org` |
| C1.2 | Confidentiality of disposed data | GDPR data deletion | Right-to-be-forgotten workflow | `src/eden/api/routes/audit.py:log_gdpr_request` |
| PI1.1 | Privacy — notice | Privacy policy | Customer-facing privacy policy | `docs/PRIVACY.md` (to be added) |
| PI2.1 | Privacy — choice & consent | Cookie consent | Cookie banner on the portal | Portal UI |

**Status legend:** ✅ shipped, ⚠ partial, ❌ not started. An auditor
should be able to walk down this table and either see the evidence
in the cited location or note the gap.

**Outstanding items (June 2026):**
- ❌ CC4.1 anomaly detector: in-memory currently; production moves to
  ClickHouse + ksqlDB in §10.3.
- ⚠ A1.2 data residency: requires §6.5 multi-region rollout before
  any EU customer can be SOC 2 attested.
- ❌ External pen test (CC4.x): see §9.1.3 — requires a contracted
  firm.

**Owner of this mapping:** Security Engineer. Reviewed monthly.
