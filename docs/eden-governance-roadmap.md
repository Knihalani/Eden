# Eden Governance Roadmap (Deferred)

ponytail: per upgradespec §D.5 (Phase 1 cut), the in-code
HIPAA + ISO27001 compliance evidence packs were removed. SOC2
Type II + GDPR (incl. Art.17 RTBF) remain shipped and
maintained. This doc tracks the deferred frameworks for when
an enterprise customer asks.

## Shipped (v1.4)

- **SOC2 Type II** — 50+ control evidence pack via
  `POST /orgs/{org_id}/intelligence/governance/compliance/soc2`.
  Generates period-start → period-end evidence: CC6.1 logical
  access, CC6.7 monitoring, CC7.3 incident response, etc.
- **GDPR** — 10 control evidence pack including Art.17 RTBF
  and Art.22 right-to-objection. Anonymisation across
  6 tables (deterministic `anon_<sha256[:16]>` ids) + audit
  log of every RTBF run. See `POST .../compliance/gdpr`.

## Deferred (when an enterprise customer asks)

### HIPAA

Security Rule §164.308 + Privacy Rule §164.514 evidence pack:

- §164.308(a)(1)(ii)(D) information system activity review
  — already partly covered by `usage_events` + audit log
- §164.308(a)(6)(i) reporting — extends Cat 2 incident
  pipeline
- §164.312(e) transmission security — extends Cat 10 PII
  scanner to flag `phi` signal type (the severity table
  comment in `_common.py` already calls this out)
- §164.514 de-identification — same RTBF machinery as
  GDPR but stricter (Safe Harbor vs. Expert Determination)

ETA: ~2 weeks once a customer with a BAA asks.

### ISO 27001:2022

Annex A 14 families evidence pack:

- A.13.2 information transfer — extends Cat 10 PII scanner
  to flag `iban` + `passport` signal types
- A.18.1 compliance — extends SOC2 pack with the ISO
  Statement of Applicability
- The remaining 12 families are largely subsumed by SOC2
  (the v1.4 SOC2 pack already covers ~80% of ISO mappings)

ETA: ~3 weeks (largely a docs + portal effort).

## Re-enable checklist

When the deferred framework ships:

1. Add `hipaa` / `iso27001` back to `SUPPORTED_FRAMEWORKS`
   in `src/eden/services/governance_intel/_common.py`.
2. Add the framework aliases back to `FRAMEWORK_ALIASES`.
3. Add the framework-specific PHI / IBAN / passport
   severities back to `SCANNER_SEVERITY`.
4. Replace the `_not_implemented` envelope in
   `intelligence_governance.py` with the real
   `generate_hipaa_evidence` / `generate_iso27001_evidence`
   calls.
5. Add the framework-specific control packs in
   `src/eden/services/governance_intel/compliance.py`.
6. Add the framework tabs back to the portal compliance
   dashboard (`compliance` route in
   `clients/portal/src/app/(portal)/governance/`).
7. Update sales materials.

## Why this is OK without customers

The HIPAA / ISO27001 packs are evidence packs, not security
features. Eden's security posture (encryption, RBAC, audit
log, RTBF, PII scanner) is framework-agnostic. The
deferred work is "generate the right PDF for the auditor" —
useful for closing enterprise deals, not for security.