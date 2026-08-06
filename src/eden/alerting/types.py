"""Canonical severity / channel vocabulary for Eden's alert-routing systems.

FEAT-44 (Wave 3, best-effort — this is explicitly a Large item, full
unification was out of scope for a single pass; see "SCOPE" below).

## The landscape today

Four+ systems generate or route alerts/incidents with no shared data
model:

1. **``eden.realtime.alert_stream`` (Kafka rule engine).**
   Has the only real typed vocabulary: :class:`AlertSeverity` (StrEnum:
   ``debug|info|warning|high|critical``) and :class:`AlertChannel`
   (StrEnum: ``in_app|websocket|email|webhook|pagerduty``). This is the
   most complete/actively-maintained representation — it's what
   ``GeneratedAlert.channels``/``.severity`` are typed as, and what
   ``_dispatch_alert`` switches on to reach in-app, websocket, email,
   webhook, and (as of FEAT-42) PagerDuty. **This module re-exports it
   as the canonical type** rather than inventing a new one.

2. **``eden.dsl.alerts`` (NL-alert / AlertAsCode / EQL watchdog).**
   Used a parallel, untyped ``frozenset[str]``: ``_VALID_SEVERITIES =
   {"info","warning","high","critical"}`` (compile-time validation) and
   ``_FIREABLE_SEVERITIES = {"info","warning","high"}`` (runtime —
   ``critical`` is deliberately excluded from firing in v1.3, a
   documented gap unrelated to this migration). No channel concept of
   its own: every fired alert goes through ``AlertTriageJudge`` →
   ``send_nl_incident_email`` — always email, so there was never a
   parallel ``AlertChannel``-shaped thing to unify here.
   **Migrated in this pass** — see below.

3. **``eden.closed_loop.playbook_router`` (22-category auto-heal router).**
   Has **no** severity or channel concept at all. Its ``category: str``
   (22 hardcoded strings — ``"hallucination"``, ``"user_frustration"``,
   ``"fleet_slo_breach"``, etc.) maps to an ``action_type`` from a small
   fixed set (``propose_patch|escalate|rollback|recommend``) via
   ``_PLAYBOOK_ACTIONS``. This is an orthogonal axis — "which
   remediation playbook to run" — not "how severe is this / who gets
   notified". Forcing it onto ``AlertSeverity``/``AlertChannel`` would
   conflate two different concepts (remediation-action selection vs.
   human-notification routing) and risks behavior change for zero
   safety benefit. **Not migrated** — flagged as a design question for
   a future pass (see "NOT DONE" below), not a mechanical rename.

4. **``eden.automations.engine`` (workflow automation notify actions).**
   Has no independent channel enum either — it dispatches directly
   through the Slack integration (``org_slack_installs`` /
   ``agent_slack_channels`` from migration 131, the same table
   ``eden.integrations.slack.store`` uses), addressing a Slack
   *channel_id* string, not one of ``AlertChannel``'s abstract channels.
   It has no severity concept visible in the engine itself. **Not
   migrated** — there's no duplicate severity/channel representation
   here to consolidate; the real gap is that it can't route to
   email/webhook/pagerduty at all, which is a feature gap, not a
   data-model duplication.

5. (Found while reading, not in the original four) **``eden.alerts.repo``**
   (``nl_alert_rules`` table, backing ``dsl.alerts``) stores a raw
   ``channels`` column read/written as opaque JSON/text — never
   validated against any enum. Same "not migrated" bucket as (3)/(4)
   for this pass; noted here so it isn't rediscovered from scratch.

## SCOPE — what this pass actually did

* Confirmed (1) ``AlertChannel``/``AlertSeverity`` in
  ``eden.realtime.alert_stream`` is the closest thing to a canonical
  type already in the codebase.
* Re-exported both here (``eden.alerting.types``) as the documented
  canonical import path, so future call sites don't have to reach into
  ``eden.realtime.alert_stream`` (a name that implies "Kafka rule
  engine", not "shared alert vocabulary") to get them.
* Migrated ``eden.dsl.alerts``'s ``_VALID_SEVERITIES`` /
  ``_FIREABLE_SEVERITIES`` frozensets to derive from ``AlertSeverity``
  instead of hand-duplicated string literals — mechanical, same
  runtime string values (``AlertSeverity`` is a ``StrEnum``, so
  ``AlertSeverity.WARNING == "warning"`` etc.), zero behavior change,
  covered by ``eden.dsl.alerts``'s existing test suite.

## NOT DONE — explicitly deferred, and why

* **No behavioral unification.** ``playbook_router``'s category→action
  mapping, ``automations.engine``'s Slack-only dispatch, and
  ``dsl.alerts``'s always-email triage pipeline all still work exactly
  as before. Rewiring them onto ``AlertChannel`` so a playbook decision
  or an automations notify-action could also page PagerDuty is real
  product value but is a rearchitecture, not a mechanical migration —
  it risks breaking working alert delivery for systems with zero
  existing test coverage of their dispatch paths (confirmed while
  building FEAT-39/40/42: only ``alert_stream.py``/``anomaly_alerts.py``
  had channel-dispatch tests before this wave).
* **``playbook_router``'s 22 categories are not severity levels** and
  should not be force-migrated onto ``AlertSeverity`` — a future pass
  should instead decide whether each category needs an *associated*
  severity (for notification purposes) as a new field, not a
  replacement of ``category``.
* **``automations.engine`` and ``eden.alerts.repo``'s raw ``channels``
  column** are not touched. A future pass should decide whether
  automations' notify actions grow real ``AlertChannel`` support
  (beyond Slack) before spending effort typing their storage.
"""

from __future__ import annotations

from eden.realtime.alert_stream import AlertChannel, AlertSeverity

__all__ = ["AlertChannel", "AlertSeverity"]
