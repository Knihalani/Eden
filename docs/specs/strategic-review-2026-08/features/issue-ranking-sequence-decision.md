# Issue ranking sequence decision (FEAT-129)

**Status:** ✅ DONE — 2026-08-07

## Decision

Composite **issue ranking** and **severity escalation** work must **not** land
before `13-continuous-improvement-loop.md` Loop 1 revival steps **P0-A** and
**P0-B** (signal recovery and confirm/dismiss wiring).

This is a **sequencing constraint**, not an implementation of ranking or
escalation. Wave 5 FEAT-129 records the dependency explicitly so future waves
do not build ranking logic against a dead confirm/dismiss pipeline.

## Prerequisite status

| Prerequisite | FEAT ID | Status |
|---|---|---|
| Loop 1 P0-A — recover `signal_id` at resolve time | FEAT-8 | ✅ done |
| Loop 1 P0-B — wire `record_shadow_feedback` for resolve/ignore | FEAT-9 | ✅ done |

With P0-A and P0-B complete, **ranking and severity-escalation work is
unblocked for future waves** — but must still consume the confirm/dismiss
signal Loop 1 now produces, per `16-issue-extraction-online-evals.md`.

## What this blocks (historically)

- Composite issue-ranking UI or scoring before Loop 1 could emit real
  confirm/dismiss feedback.
- Severity escalation that depends on dismiss/confirm signals without the
  P0-A/P0-B data contract in place.

## What this does not do

- Does **not** implement composite ranking or severity escalation (those remain
  separate feature items).
- Does **not** block Loop 1 P0-C/P0-D or other doc 13 items — only establishes
  the ordering rule for ranking/escalation relative to P0-A/P0-B.

## Source

`16-issue-extraction-online-evals.md` §6d and build-sequence notes depend on
`13-continuous-improvement-loop.md` P0-A/P0-B. This file is the canonical
forward-looking sequencing record (FEAT-129).
