---
id: pii
title: Set a PII policy
sidebar_label: Set a PII policy
sidebar_position: 6
---

# How-to — Set a PII policy

Eden's PII scanner redacts sensitive values before they hit the
dashboard. Built-in patterns cover the standard cases (email,
phone, SSN, credit card, IP, JWT); you can add custom patterns and
per-org overrides.

## Default behaviour

Out of the box, every event passes through the PII scanner. The
default policy redacts:

| Pattern | Replacement |
|---------|-------------|
| Email | `[REDACTED:email]` |
| Phone (E.164, US, intl) | `[REDACTED:phone]` |
| SSN | `[REDACTED:ssn]` |
| Credit card (Luhn-validated) | `[REDACTED:cc]` |
| IPv4 / IPv6 | `[REDACTED:ip]` |
| JWT | `[REDACTED:jwt]` |
| AWS access key | `[REDACTED:aws_key]` |
| API keys (40+ char prefix-matches) | `[REDACTED:api_key]` |

The original is **never** stored. The replacement token is what
lands in `telemetry_events.prompt`, `telemetry_events.response`, and
the trace detail view.

## Configure a custom pattern

Portal → **Settings** → **PII** → **Custom patterns** → **New pattern**.

| Field | Value |
|-------|-------|
| Name | `internal_account_id` |
| Regex | `\bACC-\d{10}\b` |
| Replacement | `[REDACTED:account_id]` |
| Fields | `prompt`, `response`, `attributes` |

Custom patterns run after the built-ins, so the built-ins always
catch their targets first.

## Per-org overrides

If your org handles a specific kind of PII differently, override
the policy:

```bash
curl -X PUT https://api.edenobservability.com/v1/orgs/org_abc/pii-policy \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "redact": ["email", "phone", "ssn", "credit_card", "custom:internal_account_id"],
    "allow_list": ["support@acme.com"],
    "fail_closed_on_decode_error": true
  }'
```

| Field | Effect |
|-------|--------|
| `redact` | Override the default list. Anything not listed passes through unredacted. |
| `allow_list` | Specific values that should never be redacted (e.g. your own support email). |
| `fail_closed_on_decode_error` | If `true`, an event that fails to scan is dropped; if `false`, it passes through with a warning. Default: `false`. |

## In-place redaction vs. drop

Eden redacts in place — the prompt and response fields keep their
length so context-window analysis stays meaningful. If you need to
**drop** the field entirely instead, set `redact_strategy: "drop"`
in the org policy.

## Audit

Every redaction emits an entry in `pii_redactions` (one row per
match), and a daily aggregate in `pii_redactions_daily`. These are
visible under **Settings → PII → Audit**.

```bash
curl https://api.edenobservability.com/v1/orgs/org_abc/pii/audit?since=2026-06-01 \
  -H "Authorization: Bearer sk_eden_admin_..."
```

The audit log is the compliance evidence pack you need for SOC 2,
HIPAA, and GDPR.

## GDPR right-to-be-forgotten

When a user invokes RTBF:

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/gdpr/erase \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{ "user_id": "u_abc" }'
```

Eden anonymises the user's data across:

- `telemetry_events.attributes->>'user_id'`
- `judge_scores.attributes->>'user_id'`
- `usage_events.user_id`
- `notifications.user_id`
- `audit_log.user_id` (becomes `anon_<sha256[:16]>`)
- Any agent attributes that reference the user

The user's id is replaced with `anon_<sha256[:16]>` deterministically,
so traces that span multiple events still join correctly — but no
PII leaks.

## Per-event opt-out

If a specific event must pass through unredacted (rare — usually
only for synthetic test data):

```python
import eden

eden.set_attribute("pii_opt_out", True)  # this event skips the scanner
```

The `pii_opt_out` attribute is itself audit-logged.