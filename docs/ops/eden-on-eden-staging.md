# Eden-on-Eden self-ingest (staging)

> F84 — dogfood observability without MCP.

## Goal

Eden's staging org ingests its own API, worker, and portal traffic so N14 quality workers, F20 detection, and F84 admin status reflect real platform behavior.

## Setup (staging only)

1. Point the Eden SDK / OTLP exporter at the staging gateway with a dedicated **dogfood** org API key.
2. Artifacts + Ledger are GA (Settings defaults `artifacts_v1` / `ledger_v1` True; missing org flags count as enabled). Dogfood org may still set explicit False for kill-switch drills.
3. Tag spans with `eden.component` ∈ `{api, worker, portal, gateway}`.
4. On **API** `/health`, expect `background_workers_expected: false` and in-process `quality_worker_running` / `evolution_loop_running` false (workers live on `eden-worker`). Confirm the worker job logs `worker: quality_pipeline started`.

## Request ID continuity

- API middleware assigns `X-Request-Id` / `request_id` on every response (including 5xx).
- Portal proxy echoes `request_id` in JSON error bodies — search logs with the same id across API → worker → gateway.
- Settings → **Platform status** shows ingest lag and worker heartbeats without SSH.

## Synthetics

`POST /orgs/{org}/admin/synthetics/run` executes deterministic probes (no paid LLM). Failures should page via existing alert channels.

## Not production

Do not enable full self-ingest on customer production tenants. Staging dogfood org only until GA soak completes.
