// k6 load test for /jobs (closes §9.3.5).
//
// Run locally:
//   docker run --rm -i grafana/k6 run - <tests/load/jobs.js
//   -e BASE_URL=http://localhost:8000 -e TOKEN=... <tests/load/jobs.js
//
// Stages:
//   1. Ramp to 100 concurrent users over 30s.
//   2. Sustain 100 for 2 minutes.
//   3. Spike to 1000 over 30s.
//   4. Sustain 1000 for 5 minutes (the "10x" target).
//   5. Ramp down.
//
// Thresholds (SLOs from docs/slo.md):
//   - http_req_duration p95 < 200ms (per-route).
//   - http_req_failed rate < 0.1% (availability SLO).

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const TOKEN = __ENV.TOKEN || "";
const ORG_ID = __ENV.ORG_ID || "";

const errorRate = new Rate("errors");
const listLatency = new Trend("list_jobs_latency", true);

export const options = {
  stages: [
    { duration: "30s", target: 100 },
    { duration: "2m", target: 100 },
    { duration: "30s", target: 1000 },
    { duration: "5m", target: 1000 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<200"],
    http_req_failed: ["rate<0.001"],
    list_jobs_latency: ["p(95)<200"],
  },
};

export default function () {
  const params = {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  const res = http.get(
    `${BASE_URL}/orgs/${ORG_ID}/jobs?limit=50`,
    params,
  );
  listLatency.add(res.timings.duration);
  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "returns jobs array": (r) => {
      try {
        const body = JSON.parse(r.body as string);
        return Array.isArray(body.jobs);
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
  sleep(0.5 + Math.random());
}
