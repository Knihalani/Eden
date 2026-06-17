---
title: "38 — Plain English Signals (Phase Q)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 38 — Plain English Signals (Phase Q)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar "Plain English Signals" gap. The user
> writes a signal in plain English
> ("LLM refusal rate above 5% in the last 24 hours") and the
> backend compiles it to a structured rule. Embedding
> clustering surfaces duplicate signals so the operator
> doesn't pile up "refusal rate above 5%" + "refusal rate
> above 7%" + "refusal rate is high".
> ~600 LOC backend + 40 unit tests.

## Goal & motivation

Laminar's headline feature on the alerts side: "Plain
English Signals". The user writes a sentence; the system
converts it to a rule. No DSL to learn. No "what's the
syntax for `<`?" question.

Eden's Cat 2 surface (Incidents + Clusters) has a
rule-based pre-filter. The user has to write a SQL/EQL
query to define an alert, which is the wrong abstraction
for non-engineers. Phase Q replaces that with NL UX.

## What's in Eden

### NL → rule compiler

The compiler is **conservative** — it picks the first
matching pattern from a fixed table, extracts the metric +
operator + threshold + window, and returns a
:class:`CompiledRule`. It doesn't claim to understand all
English; it understands the most common phrasings.

Supported metrics (8):

| Metric | NL pattern | Default unit |
|---|---|---|
| `refusal_rate` | "refusals" / "refusal rate" | % (0-1) |
| `error_rate` | "errors" / "error rate" | % (0-1) |
| `latency_p99` | "p99 latency" / "latency" | ms |
| `cost_per_call` | "cost per call" | USD |
| `tool_call_rate` | "tool calls" | count |
| `completion_tokens` | "completion tokens" / "output tokens" | count |
| `user_satisfaction` | "user satisfaction" | score (0-5) |
| `custom` | (fallback) | — |

Supported operators (6): `>`, `>=`, `<`, `<=`, `==`, `!=`.
Keywords extracted via stopword filtering.

Time windows: "in the last 24 hours" → 24, "in the past
week" → 168, "in the last minute" → 1. Default 24.

Scope filters: `agent_id=claude-opus-4`, `model=anthropic`,
`user_id=u-1`. Extracted from `key=value` patterns in the NL.

### Embedding clustering

The :class:`SignalClusterer` groups semantically similar
signals using Jaccard similarity on token sets. The
production path wires a real embedding model
(sentence-transformers) via the ``embed_fn`` kwarg; the
default uses Jaccard for unit-testability.

Algorithm: Union-Find with similarity threshold (default
0.4). The cluster_id is the smallest member id
(deterministic). The :meth:`find_duplicates` method returns
a list of (signal_a, signal_b, similarity) tuples above
the threshold — used by the operator dashboard to surface
"you already have a signal that says this".

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/signals` | yes | Create a signal from NL |
| `GET` | `/orgs/{org}/signals` | yes | List signals |
| `POST` | `/orgs/{org}/signals/{id}/match` | yes | Test a value against a signal's rule |
| `POST` | `/orgs/{org}/signals/cluster` | yes | Group similar signals |

## Example session

```bash
# Create a signal.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{"description": "LLM refusal rate above 5% in the last 24 hours"}' \
     https://app.eden.example/orgs/myorg/signals
# {
#   "id": "...",
#   "description": "LLM refusal rate above 5% in the last 24 hours",
#   "rule": {
#     "metric": "refusal_rate",
#     "op": ">",
#     "threshold": 0.05,
#     "window_hours": 24,
#     "scope": {},
#     "keywords": ["llm", "refusal", "rate", "above", "5", "24", "hours"]
#   },
#   "cluster_id": "..."
# }

# Test a value.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{"value": 0.07}' \
     https://app.eden.example/orgs/myorg/signals/<id>/match
# {"matched": true, "rule": {...}}

# Cluster similar signals.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{"similarity_threshold": 0.4}' \
     https://app.eden.example/orgs/myorg/signals/cluster
# {
#   "clusters": {
#     "s1": ["s1", "s2", "s3"],  // these 3 are similar
#     "s4": ["s4"],
#     "s5": ["s5"]
#   }
# }
```

## RagaAI / Laminar parity matrix

| Laminar feature | Eden Phase Q | Notes |
|---|---|---|
| NL → rule compilation | ✅ compile_signal() | 8 metrics, 6 operators |
| Time window extraction | ✅ _parse_window_hours() | hours / days / weeks / minutes |
| Scope filters | ✅ _parse_scope() | agent_id / model / user_id |
| Embedding clustering | ✅ SignalClusterer | Jaccard (unit-testable) + embed_fn (production) |
| Duplicate detection | ✅ find_duplicates() | Returns (a, b, sim) pairs |
| Persistence | ✅ nl_signals table | Migration 036 |
| Signal match against live telemetry | 🟡 stub | Match endpoint tests values; the scheduled job that reads from telemetry_events is Phase Q.5 |
| Re-ranker over user query | ❌ deferred | The user can always re-write the NL |
| Auto-cluster weekly | ❌ deferred | A scheduled job (Phase Q.5) |

## What's NOT in this phase (deferred)

- **Live signal matcher** — the match endpoint tests a
  single value. A scheduled job that reads from
  `telemetry_events`, computes the metric (e.g.
  `refusal_rate` over a 24h window), and fires
  `on_drift_alert` is Phase Q.5.
- **Real embedding model** — the default uses Jaccard.
  The production path wires sentence-transformers via
  `embed_fn` (a single function call).
- **Auto-cluster weekly** — a cron job that re-clusters
  the org's signals every Sunday to surface drift in
  the signal catalogue.
- **Re-ranker** — when the user writes an NL signal that
  matches multiple patterns, we pick the first match. A
  re-ranker (LLM-as-judge) would pick the most likely
  intent.

## Failure modes

| Failure | Behaviour |
|---|---|
| Empty NL | 400 (Pydantic min_length=3) |
| No pattern matches | Returns a "custom" rule with the NL keywords for downstream embedding-based matching |
| Match endpoint: signal not found | 404 |
| Threshold parsing fails (e.g. "cost > ten dollars") | Returns "custom" with the raw NL as a keyword |
| Cluster endpoint: no signals | Empty clusters dict |
| JSON encoding error in the rule | Caught at insert time; 500 |

## Telemetry

- `signal.created` (counter)
- `signal.matched` (counter) — fires per match (per `match()` call)
- `signal.clustered` (counter) — fires per cluster call

These flow into the same pipeline as LLM spans. The AI
agent can search "signals matching the keyword 'refusal'"
with no new wiring.

## Tests

40 unit tests in `tests/unit/test_nl_signals.py`:

- `TestCompileSignal` (16) — refusal rate (with + without
  threshold), error rate, latency p99 (ms / s / bare),
  cost per call (dollars / cents heuristic), tool calls,
  completion tokens, user satisfaction, custom fallback,
  windows (hours / days / minutes / week / default),
  scope extraction.
- `TestMatchSignal` (8) — all 6 operators (parametrised) +
  custom-never-matches.
- `TestSignalClusterer` (6) — single signal, similar
  signals, dissimilar signals, find_duplicates, threshold
  parameter, empty input.
- `TestSignalSignature` (3) — same NL → same sig,
  different NL → different sig, whitespace normalised.
- `TestDataclass` (2) — to_dict round-trip, defaults.
- `TestJaccard` (4) — identical, disjoint, partial, empty.

All 40 pass; 0 regressions in the existing unit suite
(649/649 total across new modules).

## Cross-references

- [Cat 2 — Root Cause + Incidents](02-root-cause-incidents.md)
  — the consumer of the signals (alert pre-filter).
- [Cat 13 — Predictive Intelligence](13-predictive-intelligence.md)
  — the drift alert pipeline that fires when a signal matches.
- [Phase M — SQL query surface](32-sql-query-surface.md)
  — the read-only surface the signal matcher reads from
  (Phase Q.5).
