# On-call scope decision (FEAT-105)

**Status:** ✅ DONE — 2026-08-07

## Decision

Eden will **not** build on-call scheduling, rotations, acknowledgment/snooze
UI, or SLA escalation timers in-house. That surface area is owned by mature
on-call products (PagerDuty, incident.io, Better Stack, Datadog On-Call, and
similar).

Eden's alerting work stays focused on **detecting and routing events** into
those tools — not replicating their escalation graphs, paging policies, or
mobile ack flows.

## What Eden does instead

- Emit alerts and incidents to external on-call integrations (PagerDuty and
  webhook-based vendors) where transport is wired.
- Keep `AlertRule` and related types minimal: severity, channels, and match
  conditions — not multi-step escalation state machines.

## Code consequences

- **FEAT-105:** `AlertRule.auto_escalate` and
  `AlertRule.escalation_delay_seconds` in `src/eden/realtime/alert_stream.py`
  remain **intentionally inert** placeholders. Do not implement in-house SLA
  timers or escalation progression against these fields.
- Do not allocate roadmap / pitch / engineering time to schedules, rotations,
  ack/snooze UI, or SLA escalation timers inside Eden.

## Source analysis

`04-alerting-oncall.md` §2 (competitive escalation-routing architecture) and
§3 fix item 9 recommend against in-house on-call primitives. This file is the
canonical forward-looking decision record.
