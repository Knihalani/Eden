# On-call handoff runbook

> **Owner:** Platform · **Last reviewed:** 2026-06-24

The Monday 10:00 handoff between outgoing and incoming on-call engineers. Used every Monday morning during rotation.

## Severity table

| Severity | Definition | Page immediately? | Examples |
|---|---|---|---|
| **SEV-1** | Production down for all orgs | Yes (page + Slack #incidents) | Postgres unavailable; Northflank deploy fails; webhook delivery 0% |
| **SEV-2** | Production degraded for >1 org | Yes (page) | Judge queue backed up >1h; budget kill-switch tripped; ClickHouse unavailable |
| **SEV-3** | Single-org issue OR non-prod | No (Slack #oncall) | Specific org reports; staging outage; test flakiness |
| **SEV-4** | Cosmetic / minor | No (next-day Slack) | Typo in docs; misnamed log field |

## Handoff checklist

Outgoing on-call fills this in Slack `#oncall-handoff` thread at 09:30 Monday:

```markdown
## Outgoing on-call: <name>, week of <date>

### Open incidents
- [SEV-2] <incident-id> — <one-line summary> — see <link>
- [SEV-3] <incident-id> — <one-line summary>

### Recent actions
- <date>: <what was done> — <why>

### Watch-list (no incident, but on the radar)
- <item>

### Pending maintenance
- <date>: <what's planned>

### Hand-off items for incoming
- <something-specific>
```

Incoming on-call acknowledges within 30 min:

> Acknowledged. Reading the handoff now.

## Tools to check before the rotation ends

* [PagerDuty schedule](https://eden.pagerduty.com/schedules) — confirm your name is OFF by 10:00
* [Slack #oncall](https://eden.slack.com/archives/oncall) — last 24h of messages
* [Grafana dashboards](https://grafana.edenobservability.com) — p95 latency + error rate + queue depth
* [Sentry](https://sentry.io/eden) — top 3 unresolved errors
* [Internal health dashboard](https://edenobservability.com/internal/health) — the Phase 4 B3 surface

## Escalation matrix

| Trigger | Escalate to | When |
|---|---|---|
| SEV-1 not resolved in 30 min | Engineering manager | Auto-page via PagerDuty escalation policy |
| SEV-2 not resolved in 2 hours | Engineering manager | Same |
| Cat 23 incident | Cat 23 on-call rotation | Per `eden.code_change` alert routing |
| ClickHouse outage | Data platform on-call | Per `eden.columnar` alert routing |
| Security incident (data breach, exploit) | Security team | Page immediately, even before SEV classification |

## Hand-off items specific to Eden

* `docs/runbooks/postgres-restore.md` — for the SEV-1 "Postgres down" path
* `docs/runbooks/migration-rollback.md` — for the botched-deploy path
* `docs/runbooks/budget-kill-switch.md` — for the "paying customer blocked" path
* `docs/docs/operations/slo.md` — the SLO targets to defend

## PTO + swaps

* Arrange a swap at least 48 hours in advance
* Update the PagerDuty schedule + Slack `#oncall` topic
* The incoming on-call should read the last 4 weeks of handoff threads