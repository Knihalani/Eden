# On-call runbook (closes part of §10.3)

This runbook covers the on-call rotation for the Eden platform.
The rotation is set up in PagerDuty / Opsgenie (the team picks
one — Opsgenie is the current default; the integration script
lives at `tools/oncall/`).

## When you are paged

1. **Acknowledge** the page within 5 minutes. If you can't,
   escalate via the rotation's secondary on-call.
2. Open the [SLO dashboard](https://grafana.example.com/d/eden-slo).
   The firing alert is annotated with a link to the panel that
   triggered it.
3. Check the [incident-response runbook](./incident-response.md)
   for the specific alert.
4. Post in `#incident` with: alert name, suspected cause, ETA
   for first update.
5. Open a GitHub issue with the `incident` label and link it in
   the channel.

## When you are NOT paged but the dashboard looks bad

Quiet incidents are still incidents. If the SLO dashboard shows
a sustained violation (>10 minutes) but no alert has fired, page
yourself. Common causes:

* The alert rule is broken (check `src/eden/observability/alerts.py`).
* The metric isn't being scraped (check Prometheus targets).
* The threshold is wrong (update the SLO target after the
  incident, not during).

## Rotation

* One-week rotations, Monday 10:00 local time.
* Hand-off doc lives in `docs/runbooks/oncall-handoff.md` (to
  be created by the team on the first rotation).
* PTO: arrange a swap at least 48 hours in advance.

## Tools

* Grafana: SLO dashboard + per-service dashboards.
* Prometheus: alert rules + ad-hoc queries.
* Loki: log search (use the structured JSON logger).
* Redis: the `eden_alerts` stream is the source of truth for
  fired alerts.
* GitHub: incidents live as issues with the `incident` label.

## See also

* [`slo.md`](../slo.md) — published SLO targets and error budget.
* [`incident-response.md`](./incident-response.md) — step-by-step
  incident handling.
* [`disaster-recovery-drill.md`](./disaster-recovery-drill.md) —
  quarterly DR drill.
