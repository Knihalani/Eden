# Redis down runbook

> **Owner:** Platform · **Last reviewed:** 2026-07-02

Recover when Redis (the dedup cache, SSE tail buffer, and rate-limiter backing store) is unavailable.

## When to use

* `/health` returns `redis: "disconnected"`
* `Customer 429 rate limited` complaints spike (the in-process rate limiter kicks in)
* `on_redis_unavailable` hook fires

## First 60 seconds — triage

1. **Verify Redis is actually down** (not just a flaky probe):
   ```bash
   # If you have a shell on the Redis host
   redis-cli ping
   # Or via the connection URL
   redis-cli -u $REDIS_URL ping
   ```
   * `PONG` → Redis is up; the `/health` probe is stale. Restart the API pod.
   * Connection refused / timeout → Redis is down. Continue.

2. **Check the Redis Cloud status page** (if hosted):
   * <https://status.redis.io/> — provider outage?
   * Upstash / Redis Cloud dashboards if we use them.

3. **Check Northflank**:
   * If we run a Redis addon, check the addon's dashboard.
   * If we use Upstash / Redis Cloud, check the provider's status page.

## First 15 minutes — fail open, then remediate

4. **Fail-open behaviour** (should be automatic):
   * Hook dedup: in-process dict (per-pod) — duplicates may occur but no data loss.
   * Rate limits: in-process deque — see `src/eden/api/middleware/rate_limit.py`.
   * SSE tail: the live-tail UI will show "Reconnecting…" until Redis returns.

5. **Restart the API** (forces a fresh probe + clears stale in-process state):
   ```bash
   # Northflank → eden-api → Runtime → Restart
   ```

6. **If the Redis instance is unrecoverable**:
   * Provision a new Redis (Upstash / Cloud Redis / Northflank addon).
   * Update `REDIS_URL` in Northflank secrets.
   * Restart `eden-api` to pick up the new URL.

7. **If only the connection is broken** (e.g. network blip):
   * Redis is designed to recover. Tail the API logs — `redis: reconnected` should appear within 1 min of Redis returning.

## After — verify

8. **Check `/health`**:
   ```bash
   curl -fsS https://api.edenobservability.com/health | jq .redis
   ```
   * Expect `"connected"`.

9. **Smoke-test the live tail**:
   * Open the portal → Observability → Live tail.
   * Send a trace event via the SDK. The event should appear in <10s.

10. **Verify rate limits**:
    * 10 rapid logins from the same IP should produce a 429 within the first 5.

## Post-mortem

* Open `INC-YYYY-MM-DD`.
* If Redis was down for >10 min, check for `cache_miss` spikes in the dashboard (the rate limiter fell back to Postgres, which is slow).
* Add a Redis health-check alert to PagerDuty if not already configured.
