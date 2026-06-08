# Eden SLOs

> Generated from `src/eden/observability/slo.py` on every release.

This page lists the published Service Level Objectives (SLOs) for
the Eden platform. Each SLO is a target we commit to, measured
over a rolling 30-day window. Error budget is the inverse — if
our SLO is 99.9% available, the error budget is 0.1% of total
requests.

## Targets

| SLO | Category | Target | Window |
|-----|----------|--------|--------|
| API availability | api | 99.9% | 30d |
| API p95 latency | api | 95% under 200ms | 30d |
| KB retrieval p95 | kb | 95% under 100ms | 30d |
| Sandbox boot p95 | sandbox | 95% under 200ms | 30d |
| LLM provider error rate | llm | 99.9% (≤0.1% errors) | 30d |
| Pipeline timeout rate | pipeline | 98% (≤2% timeouts) | 30d |

## Error budget policy

When an SLO is violated:

* The corresponding alert fires from
  `src/eden/observability/alerts.py` and is pushed to the
  `eden_alerts` Redis stream (consumed by PagerDuty / Slack).
* The on-call engineer is paged via the on-call rotation
  (see `docs/runbooks/oncall.md`).
* An incident is opened and tracked to resolution even if the
  SLO recovers automatically — recurring violations trigger a
  post-mortem.
* SLOs are reviewed quarterly; a sustained violation (>2
  consecutive windows) is grounds to lower the target or
  raise capacity.

## How to query

The SLOs are surfaced in Grafana (`docker/grafana/slo-dashboard.json`).
The Prometheus metrics `eden_slo_target` (per-SLO target as a
fraction) and `eden_http_request_duration_seconds_bucket` (the
histogram powering the latency panels) are the primary sources.

For ad-hoc queries:

```promql
# API availability over 30d
sum(rate(eden_http_requests_total{status!~"4.."}[30d]))
  / sum(rate(eden_http_requests_total[30d]))

# p95 latency per route over 5m
histogram_quantile(0.95,
  sum(rate(eden_http_request_duration_seconds_bucket[5m])) by (le, route))
```
