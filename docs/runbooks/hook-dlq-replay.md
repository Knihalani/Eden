# Hook DLQ replay runbook

> **Owner:** LLMOps · **Last reviewed:** 2026-06-24

Inspect + replay events stuck in the webhook / hook delivery dead-letter queue. Used when downstream consumers are not receiving hook events.

## When to use

* Customer reports missing webhooks (their endpoint got 0 events in the last hour)
* `on_drift_alert` / `on_judge_regression` etc. fired in the dashboard but the action didn't execute
* Portal `/settings/webhooks-dlq` shows >10 entries

## Prerequisites

* `psql` + `DATABASE_URL`
* `curl` + `EDEN_API_TOKEN`

## Steps

1. **Inspect the DLQ**:

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT id, webhook_id, event_type, attempt_count, last_error, last_attempt_at
       FROM webhook_deliveries
      WHERE status = 'dlq'
      ORDER BY last_attempt_at DESC
      LIMIT 20;
   "
   ```

2. **Pick the events to replay** (the portal's webhooks-dlq UI shows the same list):

   ```bash
   DELIVERY_ID="<from-step-1>"
   ```

3. **Test the receiver endpoint**:

   ```bash
   curl -X POST "https://customer.example.com/hook" \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

   Expected: HTTP 200. If not, the receiver is down — don't replay until it's healthy (the events will just DLQ again).

4. **Single-event replay**:

   ```bash
   curl -X POST "$BASE_URL/v1/internal/webhooks-dlq/$DELIVERY_ID/replay" \
     -H "Authorization: Bearer $EDEN_API_TOKEN"
   ```

   Expected response: `{"status": "ok", "delivery_id": "..."}`.

5. **Bulk replay** (if many events for the same webhook):

   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE webhook_deliveries
        SET status = 'pending',
            next_attempt_at = NOW(),
            attempt_count = 0
      WHERE webhook_id = '$WEBHOOK_ID'
        AND status = 'dlq';
   "
   ```

6. **Verify replay succeeded**:

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT id, status, attempt_count, last_attempt_at
       FROM webhook_deliveries
      WHERE id = '$DELIVERY_ID';
   "
   ```

   Expected: `status='delivered'`, `attempt_count >= 1`.

## Replay safety

* Replay is idempotent — the receiver should be safe to receive the same event twice
* Replay does NOT regenerate the event (no new `provider_fine_tune_id` etc.)
* Replay is rate-limited to 100 events/minute per webhook (to protect the receiver)

## Verification

* DLQ count drops to <5 within 5 minutes
* Customer's endpoint logs show the events arriving
* No new entries added to the DLQ for the same webhook in the next hour

## Related

* `docs/runbooks/judge-circuit-breaker.md`
* `clients/portal/src/app/(portal)/settings/(tabs)/webhooks-dlq/` — the UI surface