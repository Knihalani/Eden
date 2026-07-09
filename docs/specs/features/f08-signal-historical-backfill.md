# F08: Signal Historical Backfill

| Field | Value |
|---|---|
| **Feature ID** | F08 |
| **Slug** | `signal-historical-backfill` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Bento |
| **Closes gap** | 1.3 |

---

## 1. Summary

Run signal against historical trace window on create/change.

## 2. Eden current state

Not implemented.

## 3. Target behavior

Job: `POST /signal-definitions/{id}/backfill` enqueues traces.

## 4. Architecture

Celery/tick worker with rate limit.

## 5. Data model

backfill_jobs table

## 6. API specification

POST backfill, GET status

## 7. Implementation plan

`src/eden/signals/backfill.py`

## 8. SDK / CLI / Portal

Portal backfill progress bar

## 9. Feature flags & rollout

Default on signal create

## 10. Test plan

Job completes metric

## 11. Acceptance criteria

- [ ] 7d backfill finishes with progress

## 12. Dependencies

F06

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
