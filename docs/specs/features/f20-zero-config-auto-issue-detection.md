# F20: Zero-Config Automatic Issue Detection

| Field | Value |
|---|---|
| **Feature ID** | F20 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | MISSING |
| **Competitive source** | Sentrial, Raindrop, BentoLabs |
| **Dependencies** | F28 (stumbles), F29 (issues promotion) |

---

## 1. Summary

Sentrial's core pitch: **install SDK, issues appear** — loops, hallucinations, tool errors, user frustration — without configuring judges, signals, or EQL. Eden requires operator setup. F20 adds always-on detectors on `trace.finalized` that write stumbles (F28) automatically.

---

## 2. Eden current state

| What exists | Path | Why it's not enough |
|---|---|---|
| Rule-based RCA | `src/eden/insights/rca/analyzer.py:45` | On-demand POST, not automatic feed |
| Incident clusterer | `src/eden/insights/incidents/clusterer.py:106` | Deterministic buckets, manual cluster job |
| ETEC loop detection | `eden-trace-quality-system-spec.md` | Hot-path guardrails, not issue records |
| ETEC online guardrails | `src/eden/observability/quality_pipeline/` | BLOCK/STOP actions, not operator issues UI |
| Phase Q signals | `src/eden/services/cat2_intel/signals.py` | Metric rules, not per-trace semantic scan |
| InvestigationAgent | `src/eden/autonomous/investigation.py:62` | Trigger-based, not trace.finalized |

---

## 3. Target: seven default detectors

| Detector ID | Trigger condition | Severity | Data sources |
|---|---|---|---|
| `tool_error` | TOOL span with `error=true` or exception attribute | high | `telemetry_events` |
| `loop_detected` | ETEC loop ensemble score ≥ 0.85 OR hash repetition ≥ 3 | medium | trace quality API / span attrs |
| `task_failure` | `session.success=false` OR explicit failure_reason | high | F23 session metadata |
| `hallucination` | Judge score `hallucination` < 0.3 if judged; else heuristic | high | `judge_scores`, span content |
| `user_frustration` | regeneration signal OR SLM sentiment negative | medium | Cat 9 user intel + optional SLM |
| `confusion_loop` | Same assistant question repeated ≥2 without progress | medium | message sequence analysis |
| `slow_trace` | duration_ms > agent p99 baseline × 2 | low | ClickHouse rollup |
| `high_cost` | cost_usd > agent μ + 3σ | low | `telemetry_events` cost attrs |

All enabled by default for new orgs (`detection_profile=standard`).

---

## 4. Architecture

```
Redis stream: trace.finalized {org_id, trace_id, agent_id, session_id, user_id}
        │
        ▼
AutoIssueScanner.scan(trace_id)  [async worker, 5 concurrent per org]
        │
        ├─► run 7 detectors in parallel (asyncio.gather)
        ├─► each hit → StumbleWriter.create(kind, fingerprint, detail)
        └─► IssuePromoter.upsert(fingerprint)  [F29]
```

**Module:** `src/eden/issues/auto_scanner.py`

```python
class AutoIssueScanner:
    async def scan(self, org_id: str, trace_id: str) -> list[StumbleId]:
        events = await fetch_trace_events(org_id, trace_id)
        results = await asyncio.gather(
            self._detect_tool_error(events),
            self._detect_loop(events),
            # ...
        )
        stumble_ids = []
        for hit in results:
            if hit:
                stumble_ids.append(await self._stumble_writer.write(org_id, hit))
        return stumble_ids
```

**Worker registration:** `src/eden/workers/trace_finalized_consumer.py` — subscribe alongside existing quality pipeline sidecar.

---

## 5. Hallucination heuristic (when no judge)

When `judge_scores` absent:
- Tool returned empty but assistant claims data found
- Numeric claims without calculator/tool provenance
- Citation URLs not from search tool results

Use lightweight rules first; optional SLM pass batched hourly for borderline.

---

## 6. API

No new public routes required — stumbles/issues APIs (F28/F29) serve UI.

**Internal metrics:**
- `auto_issue.scan.duration_ms`
- `auto_issue.detector.{id}.hits`

**Settings:**

```python
GET /orgs/{org_id}/settings/detection
PATCH body: { profile: "minimal"|"standard"|"advanced", detectors: { tool_error: true, ... } }
```

---

## 7. SDK enhancement (improves detection)

Document + implement in `sdk/python/eden/session.py` (F23):

```python
session.complete(success=False, failure_reason="search_kb returned empty")
```

Maps to reliable `task_failure` detection (Sentrial docs parity).

---

## 8. Feature flags

| Flag | Default |
|---|---|
| `auto_issue_detection_v1` | `true` new orgs, `false` existing until opt-in |
| `auto_issue_slm_pass_v1` | `false` |

---

## 9. Tests

Fixtures in `tests/fixtures/traces/issues/`:
- `tool_error_openai.json`
- `loop_retry_bash.json`
- `frustration_regen.json`

`tests/unit/issues/test_auto_scanner.py` — parametrize 7 detectors.

---

## 10. Acceptance criteria

- [ ] Ingest failing fixture trace → stumble visible <60s without user config
- [ ] No detectors run when `detection_profile=minimal`
- [ ] Duplicate detector hits on same trace dedupe to one stumble per kind+fingerprint
- [ ] Prometheus metrics exported

---

## 11. Performance & cost optimization

### Latency

| Stage | p95 |
|---|---|
| trace.finalized → worker pickup | <10s |
| 7 detectors parallel | <500ms CPU |
| stumble written | <60s end-to-end |

### Cost model

- **$0 LLM** for 5/7 detectors (tool_error, loop, task_failure, slow_trace, high_cost)
- Optional SLM batch for hallucination/frustration: `$auto_issue_slm_pass_v1`, hourly batch not per-trace
- StatGate/ETEC reads: cached per trace quality pipeline

### Scale

- 5 concurrent scans/org; horizontal worker scale
- Skip traces >500 spans (sample every 10th step for loop detect)
- Minimal profile: 2 detectors only — for cost-sensitive orgs

### Monitoring

```
auto_issue.scan.duration_ms
auto_issue.detector.hits{detector_id}
auto_issue.queue_lag_seconds
```

---

*Downstream: F29 promotes stumbles; F30 triages issues; F46 orchestrates loop.*
