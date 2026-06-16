---
id: operations-index
title: Operations
sidebar_label: Overview
sidebar_position: 1
slug: /operations
---

# Operations

Everything you need to run Eden in production: release process,
reliability targets, security model, compliance, and on-call playbooks.

## What's in this section

<div class="eden-grid">

  <div class="eden-card">
    <div class="eden-card__icon">🛡️</div>
    <h3>Release</h3>
    <p>Branch protection, PR rules, required checks, and the release-train cadence.</p>
    <a href="/operations/branch_protection">Read →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">📈</div>
    <h3>Reliability</h3>
    <p>Service-level objectives, error budgets, and how Eden measures its own availability.</p>
    <a href="/operations/slo">Read →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">🔒</div>
    <h3>Security</h3>
    <p>Threat model, encryption at rest + in transit, key rotation, secret management.</p>
    <a href="/operations/security">Read →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">📋</div>
    <h3>SOC 2 mapping</h3>
    <p>Trust Services Criteria → Eden controls. One row per control, evidence links included.</p>
    <a href="/operations/soc2-control-mapping">Read →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">📟</div>
    <h3>Runbooks</h3>
    <p>On-call rotation, incident response, disaster recovery, KB audit, security training.</p>
    <a href="/operations/oncall">Runbooks →</a>
  </div>

</div>

## On-call

Eden uses a follow-the-sun rotation across three regions
(US-East, EU-West, APAC). The on-call engineer owns:

- The PagerDuty schedule
- The `#eden-incidents` channel
- The post-mortem template (linked in the on-call runbook)

See the [on-call runbook](/operations/oncall) for full procedures.

## Compliance posture

Eden maintains the following compliance programs:

- **SOC 2 Type II** — annual audit, current report covers
  2025-09-01 → 2026-08-31
- **HIPAA** — Business Associate Agreement available
- **GDPR** — DPA available, EU data residency supported
- **ISO 27001** — certification in progress, target Q4 2026

For audit access, contact the security team via the
[security runbook](/operations/security-training).
