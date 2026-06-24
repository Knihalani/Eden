# Judge runner circuit-breaker runbook

> **Owner:** LLMOps · **Last reviewed:** 2026-06-24

Clear the judge runner circuit breaker when OpenAI / Anthropic / other judge providers are failing. Used during a judge outage when the breaker has tripped and the queue is piling up.

## When to use

* `on_judge_regression` hook is firing repeatedly with `circuit_open=true`
* Judge runner queue depth exceeds 1000 (`/v1/internal/health/judge`)
* Judge scores are stale (>1 hour old) in the dashboard

## Prerequisites

* `psql` + `DATABASE_URL` (the judge queue is in `judge_scores`)
* `curl` + `EDEN_API_TOKEN`

## Steps

1. **Confirm the breaker is tripped**:

   ```bash
   curl -s "$BASE_URL/v1/internal/health/judge" \
     -H "Authorization: Bearer $EDEN_API_TOKEN" | jq .
   ```

   Look for `circuit_open: true` or `status: "unhealthy"`.

2. **Identify the failing provider**:

   ```bash
   psql "$DATABASE_URL" -c "
     SELECT provider, count(*) AS failed_last_hour
     FROM judge_scores
     WHERE status = 'failed'
       AND created_at >= NOW() - INTERVAL '1 hour'
     GROUP BY provider
     ORDER BY failed_last_hour DESC;
   "
   ```

3. **Check the provider's status page**:
   * OpenAI: https://status.openai.com
   * Anthropic: https://status.anthropic.com

4. **Clear the breaker** (if the provider is healthy again):

   ```bash
   psql "$DATABASE_URL" -c "
     DELETE FROM judge_circuit_breaker
     WHERE provider = '<failing-provider>';
   "
   ```

5. **Re-queue the failed jobs**:

   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE judge_scores
     SET status = 'pending', next_attempt_at = NOW()
     WHERE status = 'failed'
       AND provider = '<failing-provider>'
       AND attempt_count < 5;
   "
   ```

6. **Smoke test**:

   ```bash
   curl -X POST "$BASE_URL/v1/orgs/$ORG_ID/judge/run" \
     -H "Authorization: Bearer $EDEN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"trace_id": "<test-trace>", "judge": "hallucination"}' | jq .status
   ```

   Expected: `"ok"`.

7. **Monitor queue depth** for 10 minutes:

   ```bash
   watch -n 60 'curl -s "$BASE_URL/v1/internal/health/judge" | jq .queue_depth'
   ```

## If the provider is still down

Do NOT clear the breaker. Let it stay tripped. The queue will:
* Buffer up to `judge_runner_queue_depth` (default 5000)
* Drop with 503 after that limit
* Auto-recover when the provider's status page is green

Page the LLM vendor if the outage is >30 min.

## Verification

* Judge queue depth drops below 100 within 5 minutes of clearing the breaker
* New judge runs succeed with `status: "ok"`
* No new `circuit_open=true` events in the logs

## Related

* `docs/runbooks/budget-kill-switch.md` — related guardrail
* `src/eden/llmops/judge_runner.py` — the breaker implementation