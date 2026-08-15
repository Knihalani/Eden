# FEAT-44 — Unified alert routing (foundation)

## Problem

Four disjoint systems generated or delivered alerts with no shared model:

| System | Module | Gap |
|--------|--------|-----|
| Score-threshold automations | `eden.automations.engine` | Email-only `alert` action; Slack/webhook as separate action types |
| Playbook router | `eden.closed_loop.playbook_router` | 22 remediation categories; no severity/channel vocabulary |
| Kafka rule engine | `eden.realtime.alert_stream` | Typed `AlertSeverity` / `AlertChannel`; per-channel dispatch duplicated |
| NL / EQL alerts | `eden.dsl.alerts` | Severity strings; delivery via `send_nl_incident_email` only |

## Solution (this pass)

**Canonical module:** `src/eden/alerts/unified.py`

### Shared types

- **Severity:** `eden.alerting.types.AlertSeverity` (re-export of `eden.realtime.alert_stream.AlertSeverity`)
- **Legacy channels:** `eden.alerting.types.AlertChannel` (Kafka rule engine vocabulary)
- **Unified destinations:** `UnifiedDestinationKind` + `AlertDestination` dataclass (`email`, `slack`, `webhook`, `pagerduty`, `in_app`, `websocket`)
- **Route request:** `UnifiedAlertRouteRequest` — normalized title, message, org/tenant, severity, destinations, context

### Dispatch

`dispatch_unified_alert(request)` fans out independently to existing delivery primitives:

| Destination | Primitive |
|-------------|-----------|
| `email` | `eden.services.alert_email.send_issue_alert_email` |
| `slack` | Incoming webhook (SSRF-guarded) or `eden.integrations.slack` bot token |
| `webhook` | `settings.alert_webhook_url` or per-destination URL |
| `pagerduty` | `eden.services.pagerduty_delivery.send_pagerduty_event` |
| `in_app` | `notifications` table inserts |
| `websocket` | `broadcast_to_job_websockets` |

Each destination is best-effort; failures are captured in `UnifiedDispatchResult` and never propagate to callers.

## Migrations completed

1. **`alert_stream.AlertStreamProcessor._dispatch_alert`** — builds `route_request_from_generated_alert` and calls `dispatch_unified_alert`. FEAT-14 consumer wiring unchanged.
2. **`automations.engine._dispatch_alert`** — `action_type == "alert"` routes email through unified dispatch.

## Adapter debt (intentional)

| System | Status |
|--------|--------|
| `dsl.alerts` | Severity shared via `AlertSeverity`; firing still goes `AlertTriageJudge` → `send_nl_incident_email`. Use `destinations_from_nl_rule_channels` when rewiring. |
| `playbook_router` | Categories remain orthogonal to notification routing; docstring points to unified types for future per-category paging. |
| `closed_loop.orchestrator._maybe_alert` | Still calls `alert_email` / `slack_notify` directly. |
| `data_platform.anomaly_alerts` | Parallel per-channel dispatch; candidate for next migration. |
| `nl_alert_rules.channels` JSON | Not validated against `UnifiedDestinationKind` yet. |

## Tests

- `tests/unit/alerts/test_unified_dispatch.py` — dispatch fan-out (mocked), helpers, `alert_stream` + `automations` wiring
- Existing: `tests/unit/realtime/test_alert_stream.py`, `tests/unit/evaluation/test_automations_engine.py`, `tests/unit/dsl/test_alerts_severity_shared_type.py`

## Follow-ups

1. Rewire `send_nl_incident_email` onto `dispatch_unified_alert` using `destinations_from_nl_rule_channels`.
2. Add `slack` to automations `alert` action config (today Slack is a separate action type).
3. Migrate `anomaly_alerts.dispatch_alerts` to unified dispatch.
4. Validate `nl_alert_rules.channels` at write time against `UnifiedDestinationKind`.
