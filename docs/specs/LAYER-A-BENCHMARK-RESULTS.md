# Layer A v3 Benchmark Results

| Field | Value |
|-------|-------|
| **Date** | 2026-07-15 |
| **Detector version** | `layer_a.v3` |
| **Labels** | **35** descriptors |
| **Code** | `src/eden/evaluation/descriptors/` |
| **Wired** | `trace_finalized_consumer` → `DescriptorEngine(online=True)` |

## Verdict

Layer A v3 is the **online-practical** agent grader: same structural ceiling as v2, plus long-running damage patterns and a hot-path that stays cheap on 100+ step agents.

- Exact / structural failures: **at or above SLM** (schema, errors, auth, loops, cost, frustration, jailbreak)
- Long-agent damage: **new** — retry storms, sliding-window loops, tool thrash, assistant echo, goal abandoned
- Soft semantics: soft UTU lexicon + intent affinity + content-overlap wrong-tool + volatile-arg loop normalization
- Still weaker than a trained Luna head on: paraphrase-only grounding, deep goal completion, ambiguous near-synonym tools

**Ship v3 on 100% traffic** with `online=True` (default). Aggregate `scores` remain Luna-proxy floats.

## Labeled suite (110 cases)

| Metric | v2 | **v3** |
|--------|----|--------|
| Cases | 100 | **110** |
| Descriptors covered | 30 | **35** (31 exercised in suite) |
| Precision | 1.00 | **1.00** |
| Recall | 1.00 | **1.00** |
| F1 | 1.00 | **1.00** |
| Latency avg / p50 / p95 / max | 0.16 / 0.15 / 0.38 / 0.92 ms | **0.27 / 0.23 / 0.56 / 2.2 ms** |

Still single-digit ms on typical traces — fine on `eden-api` / worker at 1 vCPU.

### New labels (v3 long-agent)

`retry_storm`, `sliding_window_loop`, `tool_thrash`, `assistant_echo_loop`, `goal_abandoned`

### Online path (`online=True`)

| Knob | Value |
|------|-------|
| Trailing event window | 180 (keep first 3 + tail) |
| Tool-call scan cap | last 80 |
| Detector order | critical loops/errors first |
| Skip heavy grounding | short no-tool chats; long traces after a critical hit |
| Stumble promotion | `retry_storm` / `sliding_window_loop` / `tool_thrash` / `assistant_echo_loop` → `loop` |

**400-event stuck agent:** online ≈ **3.5 ms** (truncated) vs offline ≈ **12 ms** — ~3.5× cheaper, still catches `looping` / `repetitive_tool_call`.

### Aggregate scores (Luna-proxy)

Every report includes:

```json
{
  "tool_selection_quality": 0.0–1.0,
  "action_completion": 0.0–1.0,
  "groundedness": 0.0–1.0,
  "safety": 0.0–1.0,
  "efficiency": 0.0–1.0,
  "trace_quality": 0.0–1.0
}
```

Efficiency now penalizes the long-agent labels. Truncated online runs set `events_truncated: 1.0`.

## Synthetic Eden fixtures

| Archetype | Result |
|-----------|--------|
| `failing-tool` (3) | 3/3 `tool_error` (+ loops on repeated failures) |
| `loop-stuck` (3) | 3/3 `looping` |
| `adversarial-paraphrase-loop` (3) | 3/3 `looping` |
| `efficient-good` (3) | **3/3 quiet** (`trace_quality=1.0`, no grounding FPs) |
| `hallucinating` (3) | 2/3 `result_ignore` (paraphrase cases still hard) |

## Iteration highlights (v3)

1. Long-agent detectors in `long_agent.py` with prefix-aware sliding window (won't steal short alternating cycles from `looping`)
2. Soft arg normalization strips `timestamp` / `nonce` / UUIDs so retries still count as loops
3. Soft UTU lexicon (`just checking in`, `never mind`, `who are you`, …)
4. Arbitration: specific long-agent labels beat generic `looping` / `no_progress` when they apply
5. Online engine: tail window, critical-first order, early-skip heavy grounding after critical hits

## Honest ceiling vs SLM

| Capability | Layer A v3 | Trained 4B Luna |
|------------|------------|-----------------|
| Schema / loops / tool HTTP errors | **Equal or better** | Overkill |
| Long-agent stuck patterns | **Strong (new)** | Better narrative nuance |
| Wrong tool (clear intent mismatch) | **Strong** | Slightly better on ambiguity |
| Soft unnecessary (non-chitchat) | Improved lexicon | Still needed for paraphrase |
| Paraphrase grounding / deep goals | Weak | **Needed** |

## Tests

```bash
.venv/bin/python -m pytest tests/unit/evaluation/descriptors/test_layer_a.py -q --noconftest -p no:cov
# 119 passed
```
