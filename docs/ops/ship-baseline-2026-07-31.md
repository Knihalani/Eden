# Ship baseline — 2026-07-31

```json
{
  "captured_at": "2026-07-31T20:02:33.998272+00:00",
  "endpoints": {
    "/live": {
      "status": "alive",
      "version": "0.1.0",
      "commit": "2eae670652cef3dbd42fa67ac7852f974aee7c3c"
    },
    "/ready": {
      "status": "ready",
      "version": "0.1.0",
      "checks": {
        "postgres": "ok",
        "redis": "error: max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details",
        "qdrant": "ok",
        "typesense": "ok",
        "openrouter": "ok"
      }
    },
    "/health": {
      "status": "healthy",
      "version": "0.1.0",
      "postgres": "connected",
      "qdrant": "connected",
      "quality_worker_running": true,
      "statgate_installed": true,
      "evolution_loop_running": false,
      "background_workers_expected": true,
      "redis": "not_configured",
      "background_loops": {
        "supervisor_alive": true,
        "started": true,
        "acquire": {
          "api-background-v2": {
            "outcome": "acquired(via=postgres)",
            "consecutive": 1
          }
        },
        "insights_loop": true,
        "anomaly_loop": true,
        "loops": {
          "webhook_drain": "alive",
          "eql_alert_watchdog": "alive",
          "artifact_demotion": "alive",
          "maintenance": "alive",
          "self_obs_probes": "alive"
        }
      },
      "worker_heartbeat_age_seconds": 50.402971,
      "ingest_decoders_ok": true,
      "ingest_decoders_missing": []
    }
  },
  "portal": {
    "status": 200
  },
  "docs": {
    "status": 200
  },
  "notes": {
    "ci": "GitHub Actions blocked: account payments failed or spending limit needs increase (annotation on run 30657530124)",
    "redis": "Upstash at hard 500k limit; fleet on Postgres leader-election fallback \u2014 ignored per ship pass",
    "deploy_sha": "2eae670652cef3dbd42fa67ac7852f974aee7c3c",
    "northflank_instances": 1
  }
}
```
