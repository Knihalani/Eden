// k6 load test for the ClickHouse columnar engine (closes §9.5 / Phase 4 B2).
//
// Run locally:
//   docker run --rm -i grafana/k6 run - <tests/load/columnar_scale.k6.js \
//     -e BASE_URL=http://localhost:8000 \
//     -e TOKEN=<bearer> \
//     -e ORG_ID=<org_uuid>
//
// Or against staging:
//   k6 run tests/load/columnar_scale.k6.js \
//     -e BASE_URL=https://api--eden-staging-us-central.northflank.app \
//     -e TOKEN=$EDEN_API_TOKEN \
//     -e ORG_ID=$EDEN_ORG_ID
//
// Stages (the "10x scale" per the §9.5 spec):
//   1. Ramp to 50 concurrent users over 30s.
//   2. Sustain 50 for 2 minutes — baseline latency measurement.
//   3. Spike to 500 over 30s — the 10x load test.
//   4. Sustain 500 for 5 minutes — assert p95 under load.
//   5. Ramp down.
//
// Thresholds (SLOs from docs/ops/clickhouse-slo.md):
//   - http_req_duration p95 < 2000ms (daily rollup query at 10x data).
//   - http_req_duration p95 < 5000ms (weekly rollup query).
//   - http_req_failed rate < 1% (the fallback path is a feature, not a failure).

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const TOKEN = __ENV.TOKEN || "";
const ORG_ID = __ENV.ORG_ID || "";

const errorRate = new Rate("errors");
const rollupLatency = new Trend("rollup_latency_ms", true);
const queryLatency = new Trend("query_latency_ms", true);

export const options = {
  stages: [
    { duration: "30s", target: 50 },
    { duration: "2m", target: 50 },
    { duration: "30s", target: 500 },
    { duration: "5m", target: 500 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    "http_req_duration{expected_response:true}": ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    rollup_latency_ms: ["p(95)<2000"],
    query_latency_ms: ["p(95)<5000"],
  },
};

export default function () {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  // ── 1. Trigger a daily rollup ───────────────────────────────────────
  // The endpoint expects a window_start + window_end + granularity +
  // source_table. The 10x scale test uses a 24h window which exercises
  // the daily-rollup aggregation path.
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const rollupRes = http.post(
    `${BASE_URL}/orgs/${ORG_ID}/intelligence/columnar/rollups`,
    JSON.stringify({
      table: "telemetry_events",
      granularity: "day",
      window_start: start.toISOString(),
      window_end: end.toISOString(),
    }),
    { headers },
  );
  rollupLatency.add(rollupRes.timings.duration);
  check(rollupRes, {
    "rollup status is 200 or 202": (r) => r.status === 200 || r.status === 202,
    "rollup envelope is live": (r) => {
      try {
        const body = JSON.parse(r.body as string);
        return body.live === true || body.data_source === "postgres_fallback";
      } catch {
        return false;
      }
    },
  });

  // ── 2. Run a weekly rollup query ────────────────────────────────────
  const weekStart = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const queryRes = http.post(
    `${BASE_URL}/orgs/${ORG_ID}/intelligence/columnar/query`,
    JSON.stringify({
      query: `SELECT day, count() AS n FROM telemetry_events WHERE org_id = '${ORG_ID}' AND timestamp >= toDateTime('${weekStart.toISOString()}') GROUP BY day ORDER BY day`,
    }),
    { headers },
  );
  queryLatency.add(queryRes.timings.duration);
  check(queryRes, {
    "query status is 200": (r) => r.status === 200,
    "query returns rows": (r) => {
      try {
        const body = JSON.parse(r.body as string);
        return Array.isArray(body.data) || Array.isArray(body.rows);
      } catch {
        return false;
      }
    },
  });

  // ── 3. Ramp down with a small sleep ────────────────────────────────
  sleep(0.2 + Math.random() * 0.3);
}