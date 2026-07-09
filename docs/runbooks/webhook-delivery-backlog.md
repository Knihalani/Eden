# Webhook delivery backlog runbook

> **Owner:** Platform · **Last reviewed:** 2026-07-08

Triage and clear a growing backlog of pending webhook deliveries
(queue depth > 500 sustained, or delivery latency p95 > 60s).
Distinct from the DLQ replay runbook — the backlog is the in-flight
queue; the DLQ is the post-exhaustion dead-letter store.

## When to use

* `/v1/internal/health/webhooks` shows `pending > 500`
* Customer reports webhook delivery latency > 60s p95
* Northflank `eden-api` CPU spikes to >80% on the webhook worker
* `webhook_deliveries.attempt_count` distribution shows >50% of
  rows in `pending` or `retrying` state

## First 60 seconds — triage

1. **Check the queue depth**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT status, count(*) AS n,
            avg(EXTRACT(EPOCH FROM (NOW() - last_attempt_at))) AS avg_age_s
       FROM webhook_deliveries
      WHERE created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY status
      ORDER BY n DESC;
   "
   ```
   * `pending > 500` → backlog confirmed. Proceed to step 2.
   * `failed > 100` → deliveries are failing fast; the bottleneck
     is the receiver. Jump to step 4 (rate limit) and consider
     pausing the worker.
   * `in_flight > 100` (sustained) → worker is rate-limited by
     the in-process Semaphore(16) or the shared httpx pool. Step 5.

2. **Check the worker health**:
   ```bash
   curl -fsS https://api.edenobservability.com/v1/internal/health/webhooks \
     -H "Authorization: Bearer $EDEN_API_TOKEN" | jq
   ```
   * `in_flight_tasks: 16` → Semaphore saturated. Either the
     receivers are slow (expected) or one is timing out at the
     default 30s httpx timeout. Look for `TimeoutException` in
     logs.
   * `dlq_size > 1000` → receivers are rejecting at scale; flip
     to the DLQ replay runbook after the backlog is cleared.

3. **Check the failure surface**:
   ```bash
   psql "$DATABASE_URL" -c "
     SELECT split_part(url, '/', 3) AS host,
            count(*) AS n,
            count(*) FILTER (WHERE status = 'failed') AS failed
       FROM webhook_deliveries wd
       JOIN webhooks w ON w.id = wd.webhook_id
      WHERE wd.created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 10;
   "
   ```
   * One host dominates failures → that receiver is the problem.
     Notify the customer via `ops@eden`. Don't disable other
     orgs' webhooks to "fix" a single bad customer.

## First 15 minutes — remediate

4. **Pause the worker** (if a single receiver is the bottleneck):
   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE webhooks
        SET enabled = false
      WHERE id = '$BAD_WEBHOOK_ID';
   "
   ```
   Existing in-flight deliveries complete; no new ones are
   scheduled. The customer's events still land in `telemetry_events`
   — they just don't trigger webhooks until you re-enable.

5. **Raise the Semaphore** (if legitimate traffic spiked):
   ```bash
   # Bump the in-process concurrency from 16 to 32.
   # Edit ``WebhookDeliveryService._SEMAPHORE`` default and redeploy.
   # Or for an emergency hot-patch (no redeploy):
   psql "$DATABASE_URL" -c "
     UPDATE webhook_deliveries
        SET status = 'pending'
      WHERE status = 'retrying'
        AND last_attempt_at < NOW() - INTERVAL '5 minutes';
   "
   ```
   This forces stuck retries to the front of the queue. Safe to
   run repeatedly; the CAS UPDATE in `_attempt_delivery` prevents
   double-sends.

6. **Drop the timeout** (if receivers are slow but not dead):
   ```bash
   # Default httpx timeout is 30s. For a known-slow receiver:
   psql "$DATABASE_URL" -c "
     UPDATE webhooks
        SET timeout_seconds = 60
      WHERE id = '$WEBHOOK_ID';
   "
   ```
   The 60s budget is still below the 90s worker loop tick, so
   retries don't pile up.

7. **Drain and replay** (if the backlog is from a known outage):
   * Once the receiver is healthy, replay any deliveries the
     worker dropped on the floor (the rows where
     `status='failed'` and `error_message` contains `"connection"`):
     ```bash
     psql "$DATABASE_URL" -c "
       UPDATE webhook_deliveries
          SET status = 'pending',
              attempt_count = 0,
              next_attempt_at = NOW()
        WHERE status = 'failed'
          AND error_message LIKE '%connection%'
          AND created_at >= NOW() - INTERVAL '2 hours';
     "
     ```
   * This is the "reset and replay" path. Use it sparingly — it
     re-fires events that may have already been delivered over a
     different route (the customer's idempotency key is in the
     payload; if they use it correctly, replays are safe).

## After — communicate

8. **Status page**: post a notice on `status.edenobservability.com`
   if the backlog was visible to customers (latency > 5min).
9. **Customer comms**: for any org that hit the queue-depth
   warning (the `_BACKLOG_ALERT_THRESHOLD` of 500), email
   `ops@` contact with the current delivery latency.

## Post-mortem

* Open an incident in Linear (`INC-YYYY-MM-DD`).
* Add a regression test in `tests/unit/webhooks/test_backlog_pressure.py`
  that simulates a 10k pending queue + slow receiver and asserts
  the worker drains within budget.
* File any infra change (Semaphore bump, timeout increase) as
  a follow-up ticket so the hot-patch can be reverted cleanly.
