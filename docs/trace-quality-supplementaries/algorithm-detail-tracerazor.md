# TraceRazor 7 Composite Metrics — Concrete Algorithm Detail

**Purpose:** This supplementary is the *implementation-grade* reference for the
7 TraceRazor composite metrics that drive Eden's `TAS` (Trace Acceptability
Score). The main spec at `eden-trace-quality-system-spec.md` §4.2 introduces
each metric and quotes the headline numbers; this file provides the exact
pseudocode, the threshold values with rationale, the data structures, the
edge cases, and the integration points.

**Audience:** Engineers implementing Phase 2 (`TraceEfficiencyAnalyzer`) and the
maintainers who will calibrate the weights on real customer data.

**Status:** v1.0 — ready for implementation.

---

## 0. Inputs and Outputs

Every metric takes a single argument: a normalised trace (a list of
`UnifiedTraceEvent` records — see §0.1). The output of each metric is a
`MetricResult` with three fields:

```python
@dataclass
class MetricResult:
    name: str                       # "srr" | "ldi" | "tca" | ...
    raw: float                      # [0.0, 1.0], higher = better
    weight: float                   # from METRIC_WEIGHTS table
    details: dict[str, Any]         # metric-specific diagnostics
    latency_ms: float               # measured wall time
```

The composite `TAS` is computed in §6.

### 0.1 Normalised Trace Event

The `TraceEfficiencyAnalyzer` works on a normalised view of
`TelemetryEvent` — the input to each metric is a `UnifiedTraceEvent`:

```python
@dataclass(frozen=True)
class UnifiedTraceEvent:
    """One event in a trace, normalised for the analyzers.

    Mirrors the TelemetryEvent columns the metrics actually read.
    Built once per trace in TraceEfficiencyAnalyzer._normalise.
    """
    event_id: str
    event_type: str                 # "span.start" | "span.end" | "llm.completion" | "tool.call" | "env.step" | "kb.cache_lookup"
    timestamp: str                  # ISO-8601
    name: str | None               # span/llm/tool name
    agent_id: str | None
    parent_span_id: str | None
    duration_ms: float | None
    outcome: str | None            # "success" | "failure" | "partial" | "timeout" | "crash"
    payload: dict[str, Any]        # event payload (LLM I/O, tool args, etc.)
    metrics: dict[str, float]      # derived metrics (token counts, cost, latency)
    attributes: dict[str, str]
    tool_calls: list[dict[str, Any]]   # flattened from tool_calls_full
    tool_results: list[dict[str, Any]]
    finish_reason: str | None
    reasoning: dict[str, Any] | None
    cache_hit: bool
```

`_normalise(events: list[TelemetryEvent]) -> list[UnifiedTraceEvent]` is a
single pass that flattens the 39-field `TelemetryEvent` into the 13-field
view each metric needs. It also pre-computes `idx_in_trace` (the integer
position), `wall_time_ms` (float ms since the first event), and
`is_llm_call` / `is_tool_call` predicates.

### 0.2 Default Weight Vector

```python
METRIC_WEIGHTS: dict[str, float] = {
    "srr":  0.21,   # Step Redundancy Rate        (TraceRazor)
    "ldi":  0.16,   # Loop Detection Index        (TraceRazor + Felix et al.)
    "tca":  0.16,   # Tool Call Accuracy          (BFCL-inspired)
    "cce":  0.12,   # Context Carry-over Eff.     (TraceRazor)
    "rda":  0.12,   # Reasoning Depth Appropriate (TraceRazor heuristic)
    "isr":  0.12,   # Information Sufficiency     (TraceRazor)
    "obs":  0.07,   # Observation Token Share     (τ-bench + τ²-bench)
    "ccr":  0.04,   # Caveman Compression Ratio   (bonus; max of wordlist/gzip/ngram)
}
assert abs(sum(METRIC_WEIGHTS.values()) - 1.0) < 1e-9
```

The weights are calibrated against TraceRazor's τ-bench benchmark
(`crates/tracerazor-core/src/metrics/composite.rs`). Only `OBS` (τ²-bench
2026) is independently evidence-validated. The other 7 must be re-calibrated
on Eden customer data within 90 days of Phase 2 ship (see Risks §9.6).

---

## 1. SRR — Step Redundancy Rate

**Definition (TraceRazor):** "fraction of step-pairs whose normalised
similarity exceeds the threshold." A "step" is one `(llm.completion, tool.call,
tool.result)` tuple. Two steps are similar iff their MinHash-LSH Jaccard
over their concatenated `name + arguments + output` exceeds `0.65`.

**Why it matters:** SRR is the single highest-weighted composite metric.
A high SRR means the agent is redoing the same work. On `efficient-good-support`
(SRR=0), `redundant-repeated-context` (SRR≈0.6), and `optimal-path-exists`
(SRR≈0.45) — the metric cleanly distinguishes "good" from "repeating itself".

### 1.1 Algorithm

```python
import hashlib
from collections import deque
from typing import Iterable


def _minhash_shingles(text: str, k: int = 5, n_perm: int = 128) -> list[int]:
    """Compute a MinHash signature for character k-shingles of ``text``.

    Returns a list of ``n_perm`` integers; MinHash similarity = Jaccard
    estimate. k=5 (default) is tuned for tool names + argument JSON
    which average ~30-60 chars.
    """
    if not text:
        return [0] * n_perm
    shingles = {text[i:i + k] for i in range(max(1, len(text) - k + 1))}
    sig = [2**31 - 1] * n_perm
    for sh in shingles:
        # Each permutation is a SHA-256 prefix interpreted as big-endian uint64
        for i in range(n_perm):
            h = hashlib.sha256(f"{i}|{sh}".encode()).digest()
            v = int.from_bytes(h[:8], "big")
            if v < sig[i]:
                sig[i] = v
    return sig


def _jaccard_minhash(a: list[int], b: list[int]) -> float:
    """Estimate Jaccard from two MinHash signatures."""
    if len(a) != len(b) or not a:
        return 0.0
    return sum(1 for x, y in zip(a, b) if x == y) / len(a)


def compute_srr(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Step Redundancy Rate via MinHash-LSH.

    Implementation notes:
      * Only counts LLM-and-tool steps (span.start/end excluded).
      * Looks back LOOKBACK_WINDOW=256 steps to bound memory.
      * Responsive exclusions: skip consecutive identical events (those
        are the LoopDetector's job, not SRR's).
      * Sub-second even on 1000-step traces.
    """
    LOOKBACK_WINDOW = 256
    SIM_THRESHOLD = 0.65

    steps = _extract_steps(events)  # list of "name|args|result" strings
    signatures = [_minhash_shingles(s) for s in steps]
    ring: deque[list[int]] = deque(maxlen=LOOKBACK_WINDOW)

    similar_pairs = 0
    comparisons = 0
    for i, sig in enumerate(signatures):
        for prev in ring:
            comparisons += 1
            if _jaccard_minhash(sig, prev) >= SIM_THRESHOLD:
                similar_pairs += 1
                break  # one similar predecessor per step is enough
        ring.append(sig)

    raw = 1.0 - (similar_pairs / max(len(steps), 1))
    return MetricResult(
        name="srr",
        raw=raw,
        weight=METRIC_WEIGHTS["srr"],
        details={"similar_pairs": similar_pairs, "comparisons": comparisons,
                 "step_count": len(steps)},
    )
```

### 1.2 Edge Cases

| Case | Handling |
|---|---|
| Empty trace (0 steps) | SRR = 1.0 (trivially no redundancy) |
| Single step | SRR = 1.0 |
| 2-step trace | SRR = 0.0 if sim ≥ 0.65 else 1.0 |
| All steps identical (perfect loop) | SRR = 0.0 — flag in details (`"perfect_loop": True`) |
| Pure span.start/end (no LLM/tool steps) | SRR = 1.0; `"step_count": 0` |
| Truncated trace (no `span.end`) | SRR computed on what we have; `"truncated": True` in details |

### 1.3 Adversarial Paraphrase Resistance

The synthetic dataset's `adversarial-paraphrase-loop` archetype is the canary:
6 semantically-identical email-send calls with different tool names
(`send_email`/`dispatch_mail`/`post_message`/...) and argument keys
(`to`/`recipient`/`addr`/...).

Naive exact-hash detectors (one-line SRR replacement) MISS this trace.
The MinHash-LSH on `name + canonicalised-args + result-text` CATCHES it —
the k=5 shingles of the canonicalised form (`send email to subject body`)
collide across the variants after we lower-case and strip synonyms.

The canonicalisation is a small lookup table (`SynonymMap`):

```python
_SYNONYM_MAP: dict[str, str] = {
    "send": "send", "dispatch": "send", "post": "send", "transmit": "send",
    "email": "message", "mail": "message", "msg": "message", "message": "message",
    "to": "to", "recipient": "to", "addr": "to", "address": "to",
    "subject": "subject", "title": "subject", "re": "subject",
    "body": "body", "content": "body", "text": "body",
}
```

Applied via `_canonicalise_args(arguments: dict[str, Any]) -> str`:

```python
def _canonicalise_args(arguments: dict[str, Any]) -> str:
    """Return a normalised string of ``arguments`` with synonym substitution.

    The output is whitespace-separated ``key:value`` pairs sorted by key.
    Empty values dropped. This gives MinHash a stable signature across
    paraphrases.
    """
    parts: list[str] = []
    for k in sorted(arguments.keys()):
        v = arguments[k]
        if v in (None, "", [], {}):
            continue
        key_norm = _SYNONYM_MAP.get(str(k).lower(), str(k).lower())
        val_norm = _SYNONYM_MAP.get(str(v).lower(), str(v).lower())
        parts.append(f"{key_norm}:{val_norm}")
    return " ".join(parts)
```

This is the ONLY place the SRR can be defeated by adversarial paraphrase.
The synthetic dataset's `_08` ground-truth asserts SRR ≤ 0.4 on the
`adversarial-paraphrase-loop` archetype.

### 1.4 Performance

| Steps | Wall time (CPU) | Notes |
|---|---|---|
| 10 | <1 ms | cold path; dominant cost is `_minhash_shingles` |
| 100 | ~5 ms | ring of 100 signatures; O(N × K) comparisons |
| 1000 | ~50 ms | ring capped at 256; amortised O(256) per step |

**Hot-path note:** SRR is *off* the live hot path. It runs in
`TraceEfficiencyAnalyzer.analyze()` (post-hoc, <50ms/trace SLA per the
main spec §3). If the user enables `EDEN_TAS_ON_HOT_PATH=1` (off by default),
SRR is sampled at 10% — see §7.

---

## 2. LDI — Loop Detection Index

**Definition (TraceRazor + Felix et al. 2025):** "probability that the trace
contains a detectable loop, given the loop ensemble's confidence score."
The ensemble (see `algorithm-detail-loop-detectors.md`) returns a
`LoopVerdict` with confidence ∈ [0, 1]; LDI is `1 - confidence` mapped to
the trace level.

### 2.1 Algorithm

```python
def compute_ldi(
    events: list[UnifiedTraceEvent],
    loop_ensemble: "LoopDetectorEnsemble",  # injected
) -> MetricResult:
    """Loop Detection Index from the ensemble verdict.

    The ensemble runs incrementally — pass `events` once; the ensemble
    keeps its own rolling state. LDI is the trace-level summary.
    """
    verdict = loop_ensemble.check(events)   # see algorithm-detail-loop-detectors.md
    raw = 1.0 - verdict.confidence
    return MetricResult(
        name="ldi",
        raw=raw,
        weight=METRIC_WEIGHTS["ldi"],
        details={
            "loop_verdict": verdict.verdict,
            "detectors_tripped": verdict.detectors_tripped,
            "earliest_step": verdict.earliest_step,
            "latest_step": verdict.latest_step,
        },
    )
```

### 2.2 Edge Cases

| Case | Handling |
|---|---|
| Empty trace | LDI = 1.0 (no loop detected, trivial) |
| Single event | LDI = 1.0; ensemble can't trip on <2 steps |
| Trace with 1 retried call | LDI = depends on whether Jaccard > 0.8 across ≥3 of 5 |
| Adversarial paraphrase (5 tools × 5 args) | Detectors 2 + 3 must trip; ensemble confidence ≥ 0.7 → LDI ≤ 0.3 |
| LoopDetector ensemble crashes | LDI = 1.0 (assume worst-case) + flag in details |

### 2.3 Performance

Same as the ensemble: <2ms per step, <20ms per 10-step trace.

---

## 3. TCA — Tool Call Accuracy

**Definition (BFCL-inspired):** "fraction of tool calls whose outcome is
`success` AND whose first three retries (if any) are NOT the same call."
A "retry" is a subsequent `tool.call` with the same `tool_name` and
identical (canonicalised) arguments within `RETRY_LOOKAHEAD=3` steps.

### 3.1 Algorithm

```python
RETRY_LOOKAHEAD = 3
TARGET_TCA = 0.85


def compute_tca(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Tool Call Accuracy = (calls - retried_calls - failed_calls) / total.

    A "retried call" is one whose exact canonical form appears in the
    next RETRY_LOOKAHEAD steps. A "failed call" is one with
    ``outcome in {"failure", "timeout", "crash"}``.
    """
    tool_calls = [e for e in events if e.event_type == "tool.call"]
    if not tool_calls:
        return MetricResult(name="tca", raw=1.0,
                            weight=METRIC_WEIGHTS["tca"],
                            details={"tool_call_count": 0})

    retried = 0
    failed = 0
    for i, call in enumerate(tool_calls):
        # Failure
        if call.outcome in ("failure", "timeout", "crash"):
            failed += 1
        # Retry = same canonical form in the next K calls
        canon = _canonical_call(call)
        for j in range(i + 1, min(i + 1 + RETRY_LOOKAHEAD, len(tool_calls))):
            if _canonical_call(tool_calls[j]) == canon:
                retried += 1
                break

    good = len(tool_calls) - retried - failed
    raw = max(0.0, good / len(tool_calls))
    return MetricResult(
        name="tca",
        raw=raw,
        weight=METRIC_WEIGHTS["tca"],
        details={
            "tool_call_count": len(tool_calls),
            "retried": retried,
            "failed": failed,
            "good": good,
            "target_met": raw >= TARGET_TCA,
        },
    )


def _canonical_call(e: UnifiedTraceEvent) -> tuple[str, str]:
    """Return (canonical_tool_name, canonical_args_string) for a tool call.

    Canonical name = lower-case; canonical args = canonicalised by
    ``_canonicalise_args`` from §1.3. Two calls with paraphrased
    argument keys but identical semantics get the same canonical form.
    """
    name = (e.name or "").lower().strip()
    args = e.payload.get("arguments") or {}
    return (name, _canonicalise_args(args))
```

### 3.2 Edge Cases

| Case | Handling |
|---|---|
| No tool calls | TCA = 1.0; `tool_call_count=0` |
| All tools succeed first-try | TCA = 1.0 |
| All tools fail | TCA = 0.0 |
| Mix of retries and failures | TCA = (good - retried - failed) / total |
| Adversarial paraphrase retry | Caught by `_canonical_call` (same canonical form) |

### 3.3 Performance

O(N²) over `tool_calls` (N = tool call count). N ≤ 100 in 99% of traces; for
the 1% with N > 100, the `RETRY_LOOKAHEAD=3` cap keeps it to 300 comparisons.

---

## 4. CCE — Context Carry-over Efficiency

**Definition (TraceRazor):** "1 minus the 4-gram overlap ratio between
consecutive LLM call prompts, normalised by prompt size."
Bloat = "the agent carries a large redundant prefix across steps without
compressing it". Threshold: `BLOAT_THRESHOLD = 0.40` (above this = bloat).

### 4.1 Algorithm

```python
BLOAT_THRESHOLD = 0.40


def compute_cce(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Context Carry-over Efficiency.

    For each pair of consecutive LLM calls, compute 4-gram overlap
    of the system_prompt + first_user_message. ``bloat_i =
    overlap_ratio_i * log(len(prompt_i))``. Final CCE = 1 - mean(bloat).
    """
    llm_calls = [e for e in events if e.event_type == "llm.completion"
                 and e.request_body is not None]
    if len(llm_calls) < 2:
        return MetricResult(name="cce", raw=1.0,
                            weight=METRIC_WEIGHTS["cce"],
                            details={"llm_call_count": len(llm_calls)})

    bloats: list[float] = []
    for i in range(1, len(llm_calls)):
        prev_prompt = _extract_prompt_text(llm_calls[i - 1].request_body)
        curr_prompt = _extract_prompt_text(llm_calls[i].request_body)
        overlap = _ngram_overlap(prev_prompt, curr_prompt, n=4)
        size_norm = math.log1p(len(curr_prompt)) / 10.0  # /10 normalises to ~[0,1]
        bloats.append(min(1.0, overlap * size_norm))

    mean_bloat = sum(bloats) / len(bloats)
    raw = max(0.0, 1.0 - mean_bloat)
    return MetricResult(
        name="cce",
        raw=raw,
        weight=METRIC_WEIGHTS["cce"],
        details={
            "llm_call_count": len(llm_calls),
            "mean_bloat": round(mean_bloat, 4),
            "bloat_threshold": BLOAT_THRESHOLD,
            "bloat_exceeded": mean_bloat > BLOAT_THRESHOLD,
        },
    )


def _extract_prompt_text(request_body: dict[str, Any]) -> str:
    """Return the concatenated system + first user message text."""
    messages = request_body.get("messages") or []
    parts: list[str] = []
    for m in messages:
        if m.get("role") in ("system", "user"):
            content = m.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        parts.append(c.get("text", ""))
    return " ".join(parts)


def _ngram_overlap(a: str, b: str, n: int = 4) -> float:
    """Return ``|a ∩ b| / |a|`` for character n-grams (whitespace-insensitive)."""
    if not a or not b or len(a) < n or len(b) < n:
        return 0.0
    a_norm = "".join(a.split()).lower()
    b_norm = "".join(b.split()).lower()
    if len(a_norm) < n or len(b_norm) < n:
        return 0.0
    a_ngrams = {a_norm[i:i + n] for i in range(len(a_norm) - n + 1)}
    b_ngrams = {b_norm[i:i + n] for i in range(len(b_norm) - n + 1)}
    if not a_ngrams:
        return 0.0
    return len(a_ngrams & b_ngrams) / len(a_ngrams)
```

### 4.2 Edge Cases

| Case | Handling |
|---|---|
| < 2 LLM calls | CCE = 1.0 (no carry-over to measure) |
| All calls have unique prompts | CCE ≈ 1.0 |
| All calls identical | CCE → 0.0; `"bloat_exceeded": True` |
| Empty messages | Skip that pair (no contribution to mean_bloat) |

### 4.3 Performance

O(N × L) where N = number of consecutive pairs, L = prompt length.
For L ≤ 8K and N ≤ 100, sub-10ms. For L > 32K, sample to first 32K
characters and emit a `"truncated": True` flag.

---

## 5. RDA — Reasoning Depth Appropriateness

**Definition (TraceRazor heuristic):** "fraction of LLM calls whose
`slot`/`task_complexity` matches the requested reasoning depth."
Mismatched calls (cheap `slot=fast` for a complex task, or
`slot=reasoning` for a trivial one) penalise the score.

### 5.1 Algorithm

```python
COMPLEX_KEYWORDS = frozenset({
    "analyze", "synthesize", "design", "evaluate", "compare",
    "optimize", "prove", "derive", "formal", "theorem",
    "architecture", "novel", "hypothesis", "tradeoff", "infer",
})

SIMPLE_KEYWORDS = frozenset({
    "summarize", "extract", "classify", "format", "translate",
    "list", "count", "lookup", "fetch", "convert", "parse",
})


def compute_rda(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Reasoning Depth Appropriateness.

    Each LLM call is judged on whether its chosen tier matches the
    task's apparent complexity. Tier is read from ``slot`` or
    ``service_tier``; complexity is read from the prompt keywords.
    """
    llm_calls = [e for e in events if e.event_type == "llm.completion"]
    if not llm_calls:
        return MetricResult(name="rda", raw=1.0,
                            weight=METRIC_WEIGHTS["rda"],
                            details={"llm_call_count": 0})

    correct = 0
    mismatches: list[dict[str, Any]] = []
    for e in llm_calls:
        slot = (e.payload.get("slot") or e.service_tier or "standard").lower()
        prompt_text = _extract_prompt_text(e.request_body or {}).lower()
        is_complex = any(k in prompt_text for k in COMPLEX_KEYWORDS)
        is_simple = any(k in prompt_text for k in SIMPLE_KEYWORDS)

        if is_complex and slot in ("reasoning", "expert"):
            correct += 1
        elif is_simple and slot in ("fast", "extraction", "t1"):
            correct += 1
        elif not is_complex and not is_simple:
            # Ambiguous — give benefit of doubt
            correct += 1
        else:
            mismatches.append({
                "event_id": e.event_id,
                "slot": slot,
                "complexity": "complex" if is_complex else "simple",
            })

    raw = correct / len(llm_calls)
    return MetricResult(
        name="rda",
        raw=raw,
        weight=METRIC_WEIGHTS["rda"],
        details={
            "llm_call_count": len(llm_calls),
            "correct_tier": correct,
            "mismatch_count": len(mismatches),
            "mismatches": mismatches[:5],  # cap at 5 for log readability
        },
    )
```

### 5.2 Edge Cases

| Case | Handling |
|---|---|
| No LLM calls | RDA = 1.0 |
| All calls ambiguous (no keywords) | RDA = 1.0 (benefit of doubt) |
| Tier neither T1 nor reasoning (e.g. "t2") | Matches "standard"; counted as correct unless clearly mismatched |

### 5.3 Performance

O(N × L) for keyword matching. Sub-1ms for any realistic trace.

---

## 6. ISR — Information Sufficiency Rate

**Definition (TraceRazor):** "fraction of LLM steps where the response
contributes genuinely new information (i.e., windowed novelty > 0.10)."
Windowed novelty = 1 - max cosine similarity of the response embedding to
any prior response in the last 8 steps. Uses `all-MiniLM-L6-v2` (23M
params) — same model the LoopDetector ensemble uses (shared cache).

### 6.1 Algorithm

```python
ISR_NOVELTY_THRESHOLD = 0.10
ISR_LOOKBACK = 8


def compute_isr(
    events: list[UnifiedTraceEvent],
    embedder: "MiniLMEmbedder",  # injected; lazy-loaded once
) -> MetricResult:
    """Information Sufficiency Rate via windowed novelty.

    ``novelty_i = 1 - max(cosine(response_i, response_j))`` for j in the
    prior ISR_LOOKBACK steps. A step is "informative" if novelty ≥
    ISR_NOVELTY_THRESHOLD.
    """
    llm_calls = [e for e in events if e.event_type == "llm.completion"]
    if len(llm_calls) < 2:
        return MetricResult(name="isr", raw=1.0,
                            weight=METRIC_WEIGHTS["isr"],
                            details={"llm_call_count": len(llm_calls)})

    responses = [_extract_response_text(e.response_body or {}) for e in llm_calls]
    embs = [embedder.encode(r) for r in responses]

    informative = 0
    for i, e in enumerate(embs):
        max_sim = 0.0
        for j in range(max(0, i - ISR_LOOKBACK), i):
            sim = _cosine(e, embs[j])
            if sim > max_sim:
                max_sim = sim
        novelty = 1.0 - max_sim
        if novelty >= ISR_NOVELTY_THRESHOLD:
            informative += 1

    raw = informative / len(llm_calls)
    return MetricResult(
        name="isr",
        raw=raw,
        weight=METRIC_WEIGHTS["isr"],
        details={
            "llm_call_count": len(llm_calls),
            "informative": informative,
            "novelty_threshold": ISR_NOVELTY_THRESHOLD,
        },
    )


def _extract_response_text(response_body: dict[str, Any]) -> str:
    """Return the concatenated assistant message text from a response body."""
    choices = response_body.get("choices") or []
    parts: list[str] = []
    for c in choices:
        msg = c.get("message") if isinstance(c, dict) else None
        if msg and isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(content)
    return " ".join(parts) if parts else ""


def _cosine(a: list[float], b: list[float]) -> float:
    """Standard cosine similarity."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
```

### 6.2 Edge Cases

| Case | Handling |
|---|---|
| < 2 LLM calls | ISR = 1.0 (no comparison to make) |
| All responses empty | ISR = 1.0 (degenerate but acceptable) |
| All responses identical (paraphrase-loop) | ISR → 0.0 |
| MiniLM not loaded | Graceful degrade: ISR = 0.5 (unknown) + flag `"minilm_missing": True` |

### 6.3 Performance

- MiniLM embed: 1-3ms warm, 5-15ms cold. 24h process-lifetime cache.
- O(N × K) where K = ISR_LOOKBACK = 8. Sub-50ms for 100-step trace.

---

## 7. OBS — Observation Token Share

**Definition (τ²-bench 2026, TraceRazor port):** "fraction of total tokens
spent on `env.step` observations + tool results + final user-visible answer
vs total tokens. Higher = the agent is spending more on observing the world
than on internal monologue. The only metric directly evidence-validated
on τ²-bench."

### 7.1 Algorithm

```python
def compute_obs(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Observation Token Share = obs_tokens / total_tokens.

    obs_tokens = sum of tokens in:
      * ``tool_results[i].content`` for tool calls
      * ``env.step`` payload observations
      * final ``llm.completion`` response (assistant message)
    total_tokens = sum of all prompt + completion tokens across all LLM calls.
    """
    obs_tokens = 0
    total_tokens = 0

    for e in events:
        if e.event_type == "tool.call":
            for r in e.tool_results:
                content = r.get("content") if isinstance(r, dict) else None
                if isinstance(content, str):
                    obs_tokens += _estimate_tokens(content)
        elif e.event_type == "env.step":
            obs = e.payload.get("observation")
            if isinstance(obs, str):
                obs_tokens += _estimate_tokens(obs)
        elif e.event_type == "llm.completion":
            prompt = e.metrics.get("prompt_tokens", 0)
            completion = e.metrics.get("completion_tokens", 0)
            total_tokens += prompt + completion
            # Final response counts as observation
            resp_text = _extract_response_text(e.response_body or {})
            obs_tokens += _estimate_tokens(resp_text)

    if total_tokens == 0:
        return MetricResult(name="obs", raw=0.0,
                            weight=METRIC_WEIGHTS["obs"],
                            details={"total_tokens": 0})
    raw = min(1.0, obs_tokens / total_tokens)
    return MetricResult(
        name="obs",
        raw=raw,
        weight=METRIC_WEIGHTS["obs"],
        details={
            "total_tokens": total_tokens,
            "obs_tokens": obs_tokens,
            "obs_share": round(raw, 4),
        },
    )


def _estimate_tokens(text: str) -> int:
    """Rough 4-char-per-token estimator (English). Used as fallback
    when ``metrics.total_tokens`` is not available; the path that
    uses ``metrics`` is preferred."""
    return max(1, len(text) // 4)
```

### 7.2 Edge Cases

| Case | Handling |
|---|---|
| No tokens recorded (zero trace) | OBS = 0.0 |
| Only internal monologue (no tool use, no env) | OBS → 0.0 (wasteful) |
| Heavy tool use, light reasoning | OBS → 1.0 (efficient) |
| Total tokens > 1M | OBS still well-defined; `obs_tokens` capped at 1M for sanity |

### 7.3 Performance

O(N × L) where L = average event payload size. Sub-5ms for 1000-step trace.

---

## 8. CCR — Caveman Compression Ratio (bonus)

**Definition:** max of three compression ratios — `wordlist` (the agent
reuses a fixed phrase list), `gzip` (the trace compresses well = repetitive),
`ngram` (high n-gram repetition). A bonus metric; only included if
`weight > 0`.

### 8.1 Algorithm

```python
import gzip


def compute_ccr(events: list[UnifiedTraceEvent]) -> MetricResult:
    """Caveman Compression Ratio = max(wordlist, gzip, ngram).

    wordlist  = 1 - unique_words / total_words (vocab exhaustion)
    gzip      = 1 - gzip_len / raw_len (text compresses well)
    ngram     = 1 - unique_ngrams / total_ngrams (phrase reuse)

    Returns the maximum of the three; CCR is in [0, 1].
    """
    text = _extract_all_text(events)
    if len(text) < 100:
        return MetricResult(name="ccr", raw=0.0,
                            weight=METRIC_WEIGHTS["ccr"],
                            details={"text_len": len(text)})

    # wordlist
    words = text.lower().split()
    unique_words = len(set(words))
    wordlist = 1.0 - unique_words / max(len(words), 1)

    # gzip
    raw_bytes = text.encode("utf-8")
    gz_bytes = gzip.compress(raw_bytes)
    gz_ratio = 1.0 - len(gz_bytes) / len(raw_bytes)

    # 5-gram repetition
    n = 5
    ngrams = [text[i:i + n] for i in range(len(text) - n + 1)]
    unique_ngrams = len(set(ngrams))
    ngram_ratio = 1.0 - unique_ngrams / max(len(ngrams), 1)

    raw = max(wordlist, gz_ratio, ngram_ratio)
    return MetricResult(
        name="ccr",
        raw=raw,
        weight=METRIC_WEIGHTS["ccr"],
        details={
            "wordlist": round(wordlist, 4),
            "gzip": round(gz_ratio, 4),
            "ngram": round(ngram_ratio, 4),
            "best_signal": max(
                ("wordlist", wordlist),
                ("gzip", gz_ratio),
                ("ngram", ngram_ratio),
                key=lambda x: x[1],
            )[0],
        },
    )


def _extract_all_text(events: list[UnifiedTraceEvent]) -> str:
    """Concatenate all text fields for compression analysis."""
    parts: list[str] = []
    for e in events:
        for tc in e.tool_calls:
            args = (tc.get("function") or {}).get("arguments") or ""
            if isinstance(args, str):
                parts.append(args)
        for tr in e.tool_results:
            content = tr.get("content") if isinstance(tr, dict) else None
            if isinstance(content, str):
                parts.append(content)
        if e.response_body:
            parts.append(_extract_response_text(e.response_body))
    return " ".join(parts)
```

### 8.2 Edge Cases

| Case | Handling |
|---|---|
| Text < 100 chars | CCR = 0.0 |
| Single tool call, no repetition | CCR → 0.0 |
| Heavy repetition | CCR → 1.0 |

### 8.3 Performance

- Wordlist: O(L) with set counting
- gzip: ~5-20ms for L < 1MB
- ngram: O(L) with set counting

Sub-30ms total for 1MB trace.

---

## 9. Composite — TAS, AVS, VAE

The composite score `TAS` (Trace Acceptability Score) combines the 7+1
metrics via a weighted average, then multiplies by a task-value factor.

### 9.1 Algorithm

```python
def compute_tas(
    metric_results: list[MetricResult],
    task_value_score: float,   # [0, 1] — from a separate TaskDifficulty model
) -> dict[str, Any]:
    """Composite TAS / AVS / VAE computation.

    raw_tas = sum(w_i * raw_i) / sum(w_i)
    tas     = raw_tas * (0.7 + 0.3 * task_value_score)
    avs     = 100 * tas                                   # 0..100 presentation
    vae     = sum(w_i * raw_i) * task_value_score        # value-adjusted effectiveness
    grade   = "A" if avs >= 90 else "B" if avs >= 80 else
              "C" if avs >= 70 else "D" if avs >= 60 else "F"
    """
    raw_tas = sum(r.raw * r.weight for r in metric_results) / sum(r.weight for r in metric_results)
    tas = raw_tas * (0.7 + 0.3 * max(0.0, min(1.0, task_value_score)))
    avs = round(100 * tas, 2)
    vae = round(raw_tas * max(0.0, min(1.0, task_value_score)), 4)
    grade = (
        "A" if avs >= 90 else
        "B" if avs >= 80 else
        "C" if avs >= 70 else
        "D" if avs >= 60 else
        "F"
    )
    return {
        "raw_tas": round(raw_tas, 4),
        "tas": round(tas, 4),
        "avs": avs,
        "vae": vae,
        "grade": grade,
        "task_value_score": task_value_score,
        "weights_used": {r.name: r.weight for r in metric_results},
        "details": {r.name: r.details for r in metric_results},
    }
```

### 9.2 Task Value Score

The task value score `tvs ∈ [0, 1]` quantifies how important the task is.
For v0, a simple heuristic is used:

```python
def estimate_task_value(user_prompt: str, agent_id: str | None) -> float:
    """Crude task-value estimator.

    Inputs:
      * user_prompt — the user's request (from the first ``llm.completion``)
      * agent_id — the agent handling the task

    Heuristic:
      * High-value keywords (refund, security, contract, billing, …) → 1.0
      * Low-value keywords (summarize, list, format, …) → 0.3
      * Default → 0.6

    v0.1 replaces this with a Cat 13 RiskScorer-based estimate (see
    main spec §4.10 and Cat 13 implementation in ``src/eden/predictive/``).
    """
    high = any(k in user_prompt.lower() for k in
               ("refund", "security", "contract", "billing", "compliance", "auth"))
    low = any(k in user_prompt.lower() for k in
              ("summarize", "list", "format", "count", "lookup"))
    if high:
        return 1.0
    if low:
        return 0.3
    return 0.6
```

### 9.3 Edge Cases

| Case | Handling |
|---|---|
| Empty metrics list | TAS = 0.0; AVS = 0; grade = "F" |
| All metrics NaN (e.g., MiniLM missing + loop detectors crashed) | Use the available metrics only; renormalise weights |
| All metrics 1.0 (perfect) | TAS = 1.0; AVS = 100; grade = "A" |
| All metrics 0.0 (catastrophic) | TAS = 0.0; AVS = 0; grade = "F" |

---

## 10. Integration Points

### 10.1 File Layout

```
src/eden/observability/efficiency/
    __init__.py
    types.py                # UnifiedTraceEvent, MetricResult
    normalise.py            # TelemetryEvent -> UnifiedTraceEvent
    metrics/
        __init__.py
        srr.py              # Step Redundancy Rate
        ldi.py              # Loop Detection Index (wraps LoopDetectorEnsemble)
        tca.py              # Tool Call Accuracy
        cce.py              # Context Carry-over Efficiency
        rda.py              # Reasoning Depth Appropriateness
        isr.py              # Information Sufficiency Rate
        obs.py              # Observation Token Share
        ccr.py              # Caveman Compression Ratio
    composite.py            # compute_tas / compute_grade
```

### 10.2 Migration 066

```python
"""Add trace_efficiency_reports table."""
CREATE TABLE trace_efficiency_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    trace_id        TEXT NOT NULL,
    metrics         JSONB NOT NULL,                -- {srr: {...}, ldi: {...}, ...}
    raw_tas         NUMERIC(5,4) NOT NULL,         -- [0, 1]
    tas             NUMERIC(5,4) NOT NULL,         -- [0, 1]
    avs             NUMERIC(5,2) NOT NULL,         -- [0, 100]
    vae             NUMERIC(5,4) NOT NULL,
    grade           TEXT NOT NULL,                 -- 'A' | 'B' | 'C' | 'D' | 'F'
    intervention    TEXT,                          -- e.g. 'block', 'warn', 'summarize'
    fix_patches     JSONB,                         -- list of {metric, suggestion, patch}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, trace_id)
);
CREATE INDEX idx_trace_efficiency_reports_tenant_created
    ON trace_efficiency_reports (tenant_id, created_at DESC);
```

### 10.3 Routes

```python
# POST /v1/traces/{trace_id}/efficiency  → analyze on demand
# GET  /v1/traces/{trace_id}/efficiency  → retrieve latest report
```

### 10.4 Hooks

The `TraceEfficiencyAnalyzer` writes to `trace_efficiency_reports` after
analysis and fires `PromotionHook.on_judge_regression` if
`avs < 50` AND the trace's agent has shipped more than 10 traces this week.

The 8 hot-path guardrail checks (Phase 4) do NOT depend on this analyzer —
they run on the live agent loop. The analyzer is the *post-hoc* surface.

---

## 11. Test Plan (Detailed)

### 11.1 Unit Tests (per metric)

For each of the 7+1 metrics, 5 unit tests:

1. **Empty trace** → metric returns 1.0 (or 0.0 for OBS).
2. **Single step** → metric returns 1.0.
3. **Synthetic good trace** (`efficient-good-support`) → metric ≥ 0.8.
4. **Synthetic bad trace** (matching archetype) → metric ≤ 0.4.
5. **Random fuzz trace** (100 events, randomised) → metric returns a
   finite float in [0, 1] without crashing.

### 11.2 Adversarial Tests

- **Paraphrase loop on SRR:** `_08_adversarial-paraphrase-loop_*` traces must
  produce SRR ≤ 0.4 (i.e., the canonicalisation caught the paraphrase).
- **Hallucinating on OBS:** `_04_hallucinating_*` traces must produce
  OBS ≥ 0.3 (the response text is short, so most tokens are observations).
- **Cost overrun on RDA:** `_05_slow-cost-overrun_*` traces must NOT
  penalise RDA (the call was correctly sized; the issue is duration).
- **Optimal-path on SRR:** `_07_optimal-path-exists_*` traces must
  produce SRR ∈ [0.40, 0.60].

### 11.3 Integration Tests

End-to-end against `TraceEfficiencyAnalyzer.analyze()`:

- For each of the 30 synthetic traces, the computed AVS must fall within
  ±10 of the `expected_TAS` in `ground_truth`.
- For each archetype (3 variants), the `intervention` must match
  `expected_intervention`.
- For traces marked `expected_loop_detected`, the LDI metric must be ≤ 0.3.
- For traces marked `expected_hallucination_detected`, the OBS metric must
  be ≥ 0.3 AND the SRR must NOT be the lowest-scoring metric.

### 11.4 Load Tests

- 10K synthetic traces analysed serially → p99 < 50ms/trace.
- 1K traces analysed in parallel (asyncio.gather) → p99 < 200ms total.
- 100K trace stress run → no memory leaks (RSS < 2GB).

### 11.5 Edge Case Tests

| Test | Input | Expected |
|---|---|---|
| Empty events list | `[]` | TAS = 0.0; grade = "F" |
| Single span.start | `[span.start]` | TAS = 0.0 (no LLM/tool activity) |
| 1000-step mega-trace | 1000 llm.completion events | TAS computed in <50ms |
| All NaN metrics | Inject crash into LoopDetector | TAS = 0.0; `"minilm_missing": True` in details |
| Unicode-heavy trace | Emojis, RTL text | All metrics finite |
| Concurrent analysis | 10 traces in parallel | All 10 TAS values consistent |

---

## 12. Calibration Plan (Risks §9.6)

The weight vector is a guess until re-calibrated on customer data.

**Phase 2A (week 0-2):** ship with the default weights above.
**Phase 2B (week 2-12):** collect per-trace `(metrics, human_grade)` pairs
via the new "Rate this trace" portal widget. Target: ≥ 500 graded traces.
**Phase 2C (week 12-16):** fit a logistic regression on
`P(human_grade >= B) ~ weighted_sum(metrics)`. Update `METRIC_WEIGHTS`.
**Phase 2D (week 16+):** re-fit quarterly. Ship weights via the same
feature-flag mechanism as the StatGate.

The calibration is owned by the **Trace Quality Team** (Phase 11 of the
main spec). The metrics themselves are owned by **Obs v3**.

---

**Status:** Ready for implementation. Files:
- `src/eden/observability/efficiency/__init__.py`
- `src/eden/observability/efficiency/types.py`
- `src/eden/observability/efficiency/normalise.py`
- `src/eden/observability/efficiency/metrics/{srr,ldi,tca,cce,rda,isr,obs,ccr}.py`
- `src/eden/observability/efficiency/composite.py`
- `src/eden/db_migrations/versions/066_trace_efficiency_reports.py`
- `src/eden/api/routes/trace_efficiency.py`
- `tests/unit/observability/test_efficiency_*.py`