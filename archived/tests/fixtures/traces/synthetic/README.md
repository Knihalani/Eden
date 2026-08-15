# Synthetic Trace Dataset (v1)

Labelled traces for unit-testing the **non-LLM** trace-evaluation
pipeline — the heuristics that score a trace's `TAS` (Trace
Acceptability Score), pick an intervention (`allow` / `warn` /
`skip_step` / `block` / `summarize` / `escalate`), and detect
failure modes (loops, hallucinations, redundancy, truncation,
paraphrase-loop, etc.) **without** invoking a judge LLM.

Every trace is a deterministic synthetic event stream that conforms to
Eden's `TelemetryEvent` schema (`src/eden/observability/telemetry_collector.py`,
lines 32-175) — the loader in `tests/fixtures/traces/__init__.py`
reconstructs each event through the real `TelemetryEvent.from_dict`,
so any schema drift fails at load time.

## Size

| | |
|---|---|
| **Archetypes** | 10 |
| **Variants per archetype** | 3 |
| **Total traces** | **30** |
| **Events per trace** | 5-50 (per-archetype budget) |
| **Total events** | ~280 |
| **Coverage** | one `ground_truth` file per trace |

Every trace carries a matching ground-truth JSON with the labels the
evaluator must produce:

```jsonc
{
  "trace_id":                  "trace_loop_stuck_01",
  "archetype_id":              "loop-stuck",
  "expected_TAS":              19,           // 0-100
  "expected_intervention":     "block",      // allow | warn | skip_step | block | summarize | escalate
  "expected_loop_detected":    true,
  "expected_hallucination_detected": false,
  "expected_redundancy_pct":   0.0,          // 0-1
  "notes":                     "..."
}
```

## Archetypes

| # | Slug | Events | Outcome | What it tests |
|---|------|--------|---------|---------------|
| 1 | `efficient-good-support`         |  7 | success        | The baseline. 1 LLM call + 3 tool lookups. Expected `TAS > 85`, `allow`. |
| 2 | `redundant-repeated-context`     | 14 | success        | Agent re-asks the user for the same info 4 times. Expected `TAS ~50-60`, `warn`. |
| 3 | `loop-stuck`                     | 17 | timeout        | 7 consecutive `weather.lookup` retries with paraphrased arguments. Expected `TAS < 30`, `block`, `expected_loop_detected=true`. |
| 4 | `hallucinating`                  |  8 | success        | Source says NRR=122%; LLM invents "144% (top decile)". Expected `expected_hallucination_detected=true`, `warn`. |
| 5 | `slow-cost-overrun`              |  9 | success        | Well-structured but one 11.8s reasoning call blows the budget. Expected `TAS` high, `summarize` intervention (downgrade to `slot=standard`). |
| 6 | `failing-tool`                   |  8 | failure        | 3 consecutive HTTP 500s with no backoff or fallback. Expected `TAS < 30`, `escalate`. |
| 7 | `optimal-path-exists`            | 13 | success        | 18 steps that could be done in 8. Expected `TAS ~45-55`, `warn`, `expected_redundancy_pct=0.55`. |
| 8 | `efficient-multi-agent-handoff`  | 16 | success        | 3 smooth agent handoffs (intake → billing → documents → mail) with context preserved. Expected `TAS > 85`, `allow`. |
| 9 | `output-truncation`              |  5 | partial        | `finish_reason=length`, response cut off mid-word. Expected `TAS ~55-65`, `warn`. |
| 10| `adversarial-paraphrase-loop`    | 14 | success        | 6 semantically-identical email-send calls with different tool names + argument keys (e.g. `send_email(to=..., subject=..., body=...)` vs `dispatch_mail(recipient=..., title=..., message=...)`). Should **fool** exact-hash loop detectors. Expected `TAS < 30`, `block`, `expected_loop_detected=true`. |

## Layout

```
synthetic/
  traces/                           # 30 JSON files, one per trace
    01_efficient-good-support_01.json
    01_efficient-good-support_02.json
    ...
    10_adversarial-paraphrase-loop_03.json
  ground_truth/                     # 30 JSON files, same filenames
    01_efficient-good-support_01.json
    ...
  _generator/
    generate.py                     # deterministic generator (random.seed=20260628)
  README.md                         # this file
```

## Schema fidelity

Every event has all 30 fields defined in `TelemetryEvent`:

```
event_id, tenant_id, project_id, trace_id, realm,
event_type, timestamp, agent_id, agent_version, environment_id,
parent_span_id, span_id, name, duration_ms,
payload, metrics, attributes, tags, outcome,
source_format, request_body, response_body, reasoning,
tool_calls_full, tool_results, images, audio,
logprobs, citations, finish_reason, stop_sequence,
system_fingerprint, cache_hit, prompt_cache_savings_usd,
model_version, service_tier,
request_message_hashes, response_message_hashes
```

Conventions:

- `tenant_id = "org_eden_synth"`, `project_id = "proj_synthetic_eval_v1"`,
  `realm = "production"`, `agent_version = "synth-v1.0.0"`,
  `source_format = "eden_native"`.
- Every trace starts with `span.start` and ends with `span.end` on
  the same root span id; children carry the root as `parent_span_id`.
- Timestamps are ISO-8601 UTC, monotonically increasing from
  `2026-06-28T12:00:00Z`.
- `duration_ms` on the root `span.end` equals the trace's wall time.
- `logprobs` is populated on every `llm.completion` (uniform -0.1
  per token — evaluators should not rely on it as a quality signal
  for these traces).
- `cache_hit = false` on all events except where the evaluator
  tests cache behaviour (none of these do; the field is set so
  cache-aware tests have data to read).

## Intended use

1. **Unit-test a non-LLM `TAS` scorer.** For each trace, the
   scorer should return a score within ±10 of `expected_TAS`.
2. **Unit-test intervention selection.** For each trace, the
   router should emit the `expected_intervention`.
3. **Unit-test loop detectors.** Traces 3 and 10 must trigger
   `expected_loop_detected = true`; the others must not.
   Note: trace 10 specifically targets naive hash-based detectors;
   semantic / canonical-name detectors should pass while exact-hash
   detectors should fail (return false negative).
4. **Unit-test hallucination / grounding checks.** Trace 4 must
   trigger `expected_hallucination_detected = true`.
5. **Unit-test redundancy detection.** Traces 2 and 7 carry
   `expected_redundancy_pct > 0`; the detector should land within
   ±0.10.

## Quick start

```python
from tests.fixtures.traces import load_synthetic_dataset

dataset = load_synthetic_dataset()  # 30 SyntheticExample objects
for example in dataset:
    print(example.trace_id, example.archetype_id,
          "TAS=", example.expected_tas,
          "intervention=", example.expected_intervention)
    for event in example.events:
        ...  # event is a TelemetryEvent instance
```

## Regenerating the dataset

The generator is deterministic — same output every run.

```bash
.venv/bin/python tests/fixtures/traces/synthetic/_generator/generate.py
```

Each of the 3 variants per archetype is now genuinely different
(different order IDs, different hallucinated statistics, different
failing tool names, etc.) so the dataset exercises the evaluator
across a real distribution, not three copies of the same trace.

To tweak an archetype's TAS range, intervention, or event content,
edit the corresponding `make_*` function in `generate.py` and rerun.

### Re-baselining ground-truth TAS

The `expected_TAS` field in each ground-truth file is calibrated
against the **current** `compute_tas` implementation. When you
change the composite formula, regenerate the dataset AND
re-baseline the ground truth:

```bash
.venv/bin/python -c "
import json
from pathlib import Path
from tests.fixtures.traces import load_synthetic_dataset
from supplementaries.phase_2_efficiency.composite import compute_tas

gt_dir = Path('tests/fixtures/traces/synthetic/ground_truth')
for ex in load_synthetic_dataset():
    for p in gt_dir.glob('*.json'):
        gt = json.loads(p.read_text())
        if gt.get('trace_id') == ex.trace_id:
            gt['expected_TAS'] = round(compute_tas(ex.events, archetype_id=ex.archetype_id).tas)
            p.write_text(json.dumps(gt, indent=2))
            break
"
```

The `tests/integration/test_synthetic_dataset_worker_accuracy.py`
integration test verifies the worker produces TAS within ±5 and the
exact intervention for every synthetic trace — re-baseline whenever
the composite changes.

## Adding new archetypes

1. Add a `make_<archetype>(variant) -> (steps, gt)` function in
   `generate.py` that returns a `list[Step]` and a ground-truth dict.
   Make sure to vary the events across variants — see the existing
   `make_*` functions for the pattern (vary order IDs, recipient
   addresses, hallucinated statistics, durations, etc.).
2. Register it in the `ARCHETYPES` list at the bottom of `generate.py`.
3. Rerun the generator.
4. Re-baseline the ground-truth TAS (see above).
5. Add a row to the table above.
