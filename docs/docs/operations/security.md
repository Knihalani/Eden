# Eden security

> Public-facing security overview. Customers, prospects, and
> auditors should be able to read this without NDA.

## What we do

* **Encryption at rest**: Postgres (AES-256), S3 (SSE-S3),
  ClickHouse (AES-256). Customer-managed keys available on
  Enterprise.
* **Encryption in transit**: TLS 1.3 on every public endpoint;
  HSTS enabled.
* **Authentication**: email + password (argon2), TOTP-based 2FA,
  SAML 2.0 SSO, OIDC, SCIM 2.0 provisioning.
* **Authorization**: org-scoped RBAC with custom roles (§6.3).
  Every API call goes through `require_org_permission` or
  `check_resource_permission`.
* **Audit log**: tamper-evident hash chain (§6.4). `GET
  /orgs/{id}/audit-log/verify` runs the full verification.
* **Tenant isolation**: row-level security in Postgres;
  per-tenant vector collections in Qdrant; per-org data lake
  partitions in ClickHouse.

## How we test

* **SAST** on every PR: `bandit` + `semgrep` + `safety`
  (pip-audit for dependency CVEs). See
  `src/eden/security_scanner.py`.
* **DAST** weekly: OWASP ZAP baseline against staging. See
  `.github/workflows/dast.yml`.
* **Pen-test cadence** weekly: a checklist issue is auto-posted
  to `eden/security`. An external pen-test (§10.4) is engaged
  before any Fortune 500 sale.
* **Bug bounty** (§9.1.5): scope page + HackerOne program
  planned for 2026 H2.

## Compliance

* **SOC 2 Type II**: in progress. Control matrix at
  [`docs/soc2-control-mapping.md`](soc2-control-mapping.md).
* **GDPR**: `POST /orgs/{id}/gdpr-request` route + audit event
  + metric (§9.2.2). DPA available on request.
* **CCPA**: covered by the same controls as GDPR.

## How to report an issue

See [`SECURITY.md`](../SECURITY.md) for the disclosure policy
and contact channel. **Do not file public GitHub issues for
security vulnerabilities.**

## Incident history

No public incidents to date. Future incidents will be disclosed
within 72 hours via the Eden changelog and (for material
incidents) the company blog.
