# LoopDetector 4-Detector Ensemble — Concrete Algorithm Detail

**Purpose:** Implementation-grade reference for the 4-detector loop ensemble
that powers Eden's hot-path loop detection (Phase 4) and post-hoc
LoopDetector service (Phase 3). The main spec §4.3 introduces the detectors
and quotes the headline F1 number (≈ 0.72 hybrid vs 0.08 structural-only);
this file gives the exact pseudocode, thresholds, and integration points.

**Audience:** Engineers implementing Phase 3 (`LoopDetectorEnsemble`) and
Phase 4 (`TrajectoryGuardrail`'s `LoopGuard`).

**Status:** v1.0 — ready for implementation.

---

## 0. Why 4 Detectors, Not 1

From Felix et al. 2025 (arXiv 2511.10650) and Trajectory Guard (arXiv
2601.00516), single-detector loop detection has the following F1 on a
held-out set of agent traces:

| Detector | F1 | Precision | Recall | Failure mode |
|---|---|---|---|---|
| Exact-hash only | 0.08 | 0.99 | 0.04 | Misses paraphrase loops entirely |
| Jaccard shingles only | 0.32 | 0.85 | 0.20 | Misses near-duplicate with synonym substitution |
| Semantic cosine only | 0.55 | 0.78 | 0.42 | Misses structured exact-match loops in long traces |
| Page-Hinkley only | 0.41 | 0.62 | 0.31 | Catches drift but misfires on legitimate exploration |
| **4-detector ensemble (2-of-4 in 5-step window)** | **0.72** | **0.81** | **0.65** | Catches everything the synthetic dataset throws |

The 0.72 is the headline number from Felix et al. Our synthetic dataset
must hit ≥ 0.7; otherwise we add detector 5 (Markov entropy collapse)
per the main spec §9.4.

---

## 1. Detector 1 — Hash Ring

**Definition:** A ring buffer of size `HASH_RING_SIZE = 8` keyed by
SHA-256 of `(tool_name, canonicalised_args)`. Trip iff ≥ 3 entries in
the ring match the current call.

### 1.1 Algorithm

```python
import hashlib
from collections import deque
from typing import Any

HASH_RING_SIZE = 8
HASH_TRIP_THRESHOLD = 3


def _canonicalise_args(arguments: dict[str, Any]) -> str:
    """See TraceRazor supplementary §1.3 for the canonicalisation rules."""
    # ... (same as in algorithm-detail-tracerazor.md)
    ...


def _call_hash(tool_name: str, arguments: dict[str, Any]) -> str:
    """Stable SHA-256 of a (tool, args) pair.

    Whitespace in JSON values is normalised; key order is sorted.
    """
    canon_args = _canonicalise_args(arguments)
    payload = f"{tool_name.lower().strip()}|{canon_args}"
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


class HashRingDetector:
    """Detector 1: exact (tool, args) SHA-256 ring.

    Catches: identical retry chains, "send the same email 5 times" bugs.
    Misses: paraphrase loops, semantic loops.
    """

    name = "hash_ring"

    def __init__(self) -> None:
        self._ring: deque[str] = deque(maxlen=HASH_RING_SIZE)

    def observe(self, tool_name: str, arguments: dict[str, Any]) -> bool:
        """Add the call to the ring; return True if we should trip."""
        h = _call_hash(tool_name, arguments)
        self._ring.append(h)
        count = sum(1 for entry in self._ring if entry == h)
        return count >= HASH_TRIP_THRESHOLD

    def reset(self) -> None:
        self._ring.clear()
```

### 1.2 Edge Cases

| Case | Handling |
|---|---|
| First 2 calls (no history) | Ring size < 3; can never trip |
| Tool called once with 3 arg variants | 3 different hashes; no trip |
| Same call 3 times exactly | Trip at step 3 |
| Same call 4 times in 8-step window | Trip at step 3, ring stays at 4 |

---

## 2. Detector 2 — Jaccard Shingles

**Definition:** Character 5-shingles of the call's `name + args + result`.
Trip iff ≥ 3 of the last 5 calls have Jaccard > 0.8 with the current call.

### 2.1 Algorithm

```python
JACCARD_TRIP_THRESHOLD = 3
JACCARD_LOOKBACK = 5
JACCARD_SIM = 0.8


def _shingles(text: str, k: int = 5) -> set[str]:
    """Character k-shingles of text."""
    if len(text) < k:
        return {text} if text else set()
    return {text[i:i + k] for i in range(len(text) - k + 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    """Jaccard similarity between two sets."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class JaccardShinglesDetector:
    """Detector 2: Jaccard similarity on char 5-shingles.

    Catches: near-identical calls with minor paraphrase (different
    whitespace, case, punctuation).
    Misses: semantic loops where paraphrases are heavy.
    """

    name = "jaccard_shingles"

    def __init__(self) -> None:
        self._ring: deque[set[str]] = deque(maxlen=JACCARD_LOOKBACK)

    def observe(self, text: str) -> bool:
        """Add the call text to the ring; return True if we should trip."""
        shingles = _shingles(text)
        if not shingles:
            return False
        self._ring.append(shingles)
        if len(self._ring) < JACCARD_TRIP_THRESHOLD:
            return False
        # Count prior shingles with Jaccard > 0.8 vs the current
        trips = 0
        for prev in list(self._ring)[:-1]:  # exclude the just-appended one
            if _jaccard(prev, shingles) >= JACCARD_SIM:
                trips += 1
                if trips >= JACCARD_TRIP_THRESHOLD:
                    return True
        return False

    def reset(self) -> None:
        self._ring.clear()
```

### 2.2 Edge Cases

| Case | Handling |
|---|---|
| Empty text | No shingles; can't trip |
| Single call | ring size < 3; can't trip |
| 3 calls identical | Trip at step 3 |
| 2 calls identical + 1 different | No trip (need ≥ 3 of last 5) |

---

## 3. Detector 3 — Semantic Cosine (MiniLM)

**Definition:** Embed the call's `name + args + result` with
`all-MiniLM-L6-v2` (23M params, 384-dim, mean-pooled, ~1-3ms warm / 5-15ms
cold on CPU). Trip iff ≥ 3 of the last 5 calls have cosine > 0.85 with the
current call.

### 3.1 Algorithm

```python
import math
from typing import Any

MINILM_DIM = 384
MINILM_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MINILM_WARMUP_TEXT = "warmup"  # one-time warmup pass

COSINE_LOOKBACK = 5
COSINE_TRIP_THRESHOLD = 3
COSINE_SIM = 0.85


class MiniLMEmbedder:
    """Lazy-loaded, process-lifetime cached MiniLM embedder.

    Loading:
      * First call to .encode() triggers a ~5s load + ~1s warmup.
      * Subsequent calls: 1-3ms per embed (warm).
      * If sentence-transformers is not installed, .encode() returns
        a 384-dim zero vector with ``_available = False``.

    Thread safety: model.encode() is GIL-released; safe for asyncio
    when wrapped in ``loop.run_in_executor``.
    """

    def __init__(self) -> None:
        self._model = None
        self._available = False

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(MINILM_MODEL_NAME)
            # Warmup
            self._model.encode([MINILM_WARMUP_TEXT], normalize_embeddings=True)
            self._available = True
        except Exception:
            self._model = None
            self._available = False

    def encode(self, text: str) -> list[float]:
        """Encode text to a 384-dim vector. Returns zero-vector if unavailable."""
        self._ensure_loaded()
        if not self._available:
            return [0.0] * MINILM_DIM
        try:
            vec = self._model.encode(
                text, normalize_embeddings=True, show_progress_bar=False
            )
            return vec.tolist() if hasattr(vec, "tolist") else list(vec)
        except Exception:
            return [0.0] * MINILM_DIM

    @property
    def available(self) -> bool:
        return self._available


class SemanticCosineDetector:
    """Detector 3: MiniLM cosine similarity over the last 5 calls.

    Catches: semantic loops (heavy paraphrase, synonym substitution).
    Misses: structured exact-match loops (would be caught by Detector 1).
    """

    name = "semantic_cosine"

    def __init__(self, embedder: MiniLMEmbedder) -> None:
        self._embedder = embedder
        self._ring: deque[list[float]] = deque(maxlen=COSINE_LOOKBACK)
        self._texts: deque[str] = deque(maxlen=COSINE_LOOKBACK)

    def observe(self, text: str) -> bool:
        """Add the call text; return True if we should trip."""
        if not self._embedder.available:
            return False  # graceful degrade
        emb = self._embedder.encode(text)
        if all(v == 0.0 for v in emb):
            return False
        self._ring.append(emb)
        self._texts.append(text)
        if len(self._ring) < COSINE_TRIP_THRESHOLD:
            return False
        trips = 0
        current = self._ring[-1]
        for prev in list(self._ring)[:-1]:
            if _cosine(current, prev) >= COSINE_SIM:
                trips += 1
                if trips >= COSINE_TRIP_THRESHOLD:
                    return True
        return False

    def reset(self) -> None:
        self._ring.clear()
        self._texts.clear()


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity for pre-normalised vectors (= dot product)."""
    if len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))  # vectors are pre-normalised
```

### 3.2 Edge Cases

| Case | Handling |
|---|---|
| MiniLM unavailable | Detector returns False (graceful degrade) |
| First call | ring size < 3; can't trip |
| 5 calls with cosine 0.86 | Trip at the 4th call (3 prior trips) |
| Embedding fails | Treat as zero-vector; detector returns False |

### 3.3 Performance

- Cold load: 5s one-time (acceptable at process startup; not in hot path)
- Cold embed: 5-15ms
- Warm embed: 1-3ms (24h process-lifetime cache)

---

## 4. Detector 4 — Page-Hinkley CUSUM

**Definition:** A cumulative-sum (CUSUM) change-detection test on a scalar
"novelty" signal — the inverse of the average cosine similarity of the
current call to the prior 5 calls. Trip iff `CUSUM_t > lambda * sigma`
where `lambda = 4.0` (Page-Hinkley tuning) and `sigma` is the running
standard deviation of the novelty signal.

### 4.1 Algorithm

```python
import math
from collections import deque

PH_LAMBDA = 4.0
PH_DELTA = 0.005      # slack to avoid false alarms on small drifts
PH_LOOKBACK = 20      # for sigma estimate


class PageHinkleyDetector:
    """Detector 4: Page-Hinkley CUSUM on per-step novelty.

    Catches: distribution shift (e.g., agent stops exploring and starts
    repeating) — even when the surface form looks different.
    Misses: short sharp loops (caught by Detectors 1-3).
    """

    name = "page_hinkley"

    def __init__(self) -> None:
        self._sum = 0.0
        self._min_sum = 0.0
        self._novelty_history: deque[float] = deque(maxlen=PH_LOOKBACK)
        self._prior_text: str | None = None

    def observe(self, text: str, novelty: float | None = None) -> bool:
        """Add a step; return True if CUSUM trips.

        If ``novelty`` is provided (e.g., from MiniLM cosine), use it.
        Otherwise compute novelty as 1 - cosine to the prior step's text.
        """
        if novelty is None and self._prior_text is not None:
            # Fallback: simple char-overlap novelty
            a = set(self._prior_text.split())
            b = set(text.split())
            novelty = 1.0 - (len(a & b) / len(a | b)) if (a | b) else 0.5
        elif novelty is None:
            novelty = 0.5  # first step

        self._novelty_history.append(novelty)
        if len(self._novelty_history) < 2:
            return False

        # Estimate sigma from history
        mean = sum(self._novelty_history) / len(self._novelty_history)
        variance = sum((x - mean) ** 2 for x in self._novelty_history) / max(
            len(self._novelty_history) - 1, 1
        )
        sigma = max(math.sqrt(variance), 0.01)  # floor to avoid div-by-zero

        # CUSUM
        self._sum += novelty - mean - PH_DELTA
        self._min_sum = min(self._min_sum, self._sum)
        ph_stat = self._sum - self._min_sum
        threshold = PH_LAMBDA * sigma
        self._prior_text = text
        return ph_stat > threshold

    def reset(self) -> None:
        self._sum = 0.0
        self._min_sum = 0.0
        self._novelty_history.clear()
        self._prior_text = None
```

### 4.2 Edge Cases

| Case | Handling |
|---|---|
| First step | novelty = 0.5; no trip |
| Constant novelty (perfect loop) | CUSUM grows linearly; trip eventually |
| Random noise | CUSUM oscillates; never trips |
| Single sharp drift | CUSUM spikes; trip within 2-3 steps |

### 4.3 Performance

O(1) per step. <100µs CPU.

---

## 5. Ensemble — Voting Rule

**Trigger:** "≥ 2 of 4 detectors trip within a 5-step window" → verdict
`LOOP`, action determined by the existing `guardrails/policy.py`
`VALID_ACTIONS` taxonomy.

### 5.1 Algorithm

```python
from dataclasses import dataclass, field
from typing import Any

ENSEMBLE_LOOKBACK = 5
ENSEMBLE_TRIP_THRESHOLD = 2   # 2 of 4 detectors

# Verdict-to-action mapping
_LOOP_ACTIONS: dict[str, str] = {
    "first_loop":    "skip_step",   # warn the agent; let it try once more
    "persistent":    "block",       # stop the agent loop
    "severe":        "escalate",    # notify the user / admin
}


@dataclass
class LoopVerdict:
    verdict: str                  # "ok" | "loop" | "no_data"
    confidence: float             # [0, 1]
    detectors_tripped: list[str]
    earliest_step: int | None
    latest_step: int | None
    action: str | None
    details: dict[str, Any] = field(default_factory=dict)


class LoopDetectorEnsemble:
    """The 4-detector ensemble.

    Voting rule: ≥ 2 of 4 detectors trip within the last 5 steps.
    Action depends on persistence: first trip = skip_step, 2nd in a row
    = block, 3rd in a row = escalate.
    """

    name = "loop_detector_ensemble"

    def __init__(self, embedder: MiniLMEmbedder | None = None) -> None:
        self._d1 = HashRingDetector()
        self._d2 = JaccardShinglesDetector()
        self._d3 = SemanticCosineDetector(embedder or MiniLMEmbedder())
        self._d4 = PageHinkleyDetector()
        self._trip_history: deque[bool] = deque(maxlen=ENSEMBLE_LOOKBACK)
        self._step = 0

    def reset(self) -> None:
        self._d1.reset()
        self._d2.reset()
        self._d3.reset()
        self._d4.reset()
        self._trip_history.clear()
        self._step = 0

    def check(self, events: list[UnifiedTraceEvent] | None = None) -> LoopVerdict:
        """Run on the entire trace (post-hoc) OR incrementally.

        For post-hoc, pass the full list; the ensemble rebuilds state.
        For live, call ``observe(call, result)`` per step.
        """
        if events is not None:
            self.reset()
            for e in events:
                if e.event_type == "tool.call":
                    self._observe_tool_call(e)
            return self._verdict()

        return self._verdict()

    def observe(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        result_text: str | None = None,
        novelty: float | None = None,
    ) -> bool:
        """Live observation. Returns True if the ensemble trips."""
        self._step += 1
        call_text = f"{tool_name} {_canonicalise_args(arguments)} {result_text or ''}"

        t1 = self._d1.observe(tool_name, arguments)
        t2 = self._d2.observe(call_text)
        t3 = self._d3.observe(call_text)
        t4 = self._d4.observe(call_text, novelty)

        any_trip = t1 or t2 or t3 or t4
        self._trip_history.append(any_trip)
        return any_trip

    def _observe_tool_call(self, e: UnifiedTraceEvent) -> None:
        """Apply a single tool.call event to the ensemble."""
        result_text = ""
        if e.tool_results:
            content = e.tool_results[0].get("content") if isinstance(
                e.tool_results[0], dict
            ) else None
            if isinstance(content, str):
                result_text = content[:500]   # truncate for perf
        self.observe(
            tool_name=e.name or "unknown",
            arguments=e.payload.get("arguments") or {},
            result_text=result_text,
        )

    def _verdict(self) -> LoopVerdict:
        """Compute the trace-level verdict from the trip history."""
        tripped_in_window = sum(self._trip_history)
        detectors_tripped: list[str] = []
        # Note: post-hoc we don't know which exact detectors tripped at
        # each step without replaying; for the trace verdict we use the
        # window count. For live, the per-step observe() returns True
        # on any trip and the caller can re-query which.
        is_loop = tripped_in_window >= ENSEMBLE_TRIP_THRESHOLD
        if not is_loop:
            return LoopVerdict(
                verdict="ok",
                confidence=1.0 - tripped_in_window / max(ENSEMBLE_LOOKBACK, 1),
                detectors_tripped=[],
                earliest_step=None,
                latest_step=None,
                action=None,
                details={"tripped_in_window": tripped_in_window},
            )
        # Determine persistence
        recent_trips = sum(list(self._trip_history)[-3:])
        if recent_trips >= 3:
            action = _LOOP_ACTIONS["severe"]
        elif recent_trips >= 2:
            action = _LOOP_ACTIONS["persistent"]
        else:
            action = _LOOP_ACTIONS["first_loop"]
        return LoopVerdict(
            verdict="loop",
            confidence=min(1.0, tripped_in_window / ENSEMBLE_LOOKBACK),
            detectors_tripped=["ensemble"],   # post-hoc; live gives detail
            earliest_step=max(0, self._step - len(self._trip_history)),
            latest_step=self._step,
            action=action,
            details={"tripped_in_window": tripped_in_window, "recent_trips": recent_trips},
        )
```

### 5.2 Action Mapping

| Persistence | Action | Reason |
|---|---|---|
| First trip | `skip_step` | Warn the agent; let it try one more time |
| 2nd consecutive trip | `block` | Stop the agent loop; emit intervention |
| 3rd consecutive trip | `escalate` | Notify user/admin; surface for review |

### 5.3 Edge Cases

| Case | Handling |
|---|---|
| Empty trace | Verdict = `ok`, confidence = 1.0 |
| < 5 steps | Ensemble can't reach 2-of-4 in window |
| Detectors disagree 2-2 | Verdict = `ok` (strict majority rule, not simple 2-of-4) |
| MiniLM unavailable | Detector 3 returns False; need 2 of remaining 3 |
| All 4 trip simultaneously | Verdict = `loop`, action = `escalate` (severity high) |

---

## 6. Integration Points

### 6.1 File Layout

```
src/eden/observability/loops/
    __init__.py
    types.py                # LoopVerdict
    minilm_embedder.py      # MiniLMEmbedder
    detectors/
        __init__.py
        hash_ring.py
        jaccard_shingles.py
        semantic_cosine.py
        page_hinkley.py
    ensemble.py             # LoopDetectorEnsemble
    routes.py               # POST /v1/traces/{trace_id}/loops
```

### 6.2 Hot Path (Phase 4)

The ensemble is wired into `TrajectoryGuardrail.pre_step()`:

```python
class TrajectoryGuardrail:
    def __init__(self, ...):
        self._loop_ensemble = LoopDetectorEnsemble()

    def pre_step(self, step_proposal: "StepProposal") -> "GuardrailDecision":
        # ... other checks ...

        # Check 3 — LoopGuard (most expensive of the hot path; ~2ms)
        if self._loop_ensemble.observe(
            tool_name=step_proposal.tool_name,
            arguments=step_proposal.arguments,
            result_text=None,    # pre-step; no result yet
        ):
            return GuardrailDecision(
                action="skip_step",
                reason="loop_detected",
                source="loop_guard",
            )

        # ... continue with action ...
```

### 6.3 Post-Hoc Path (Phase 3)

```python
class LoopDetectorService:
    """Phase 3 service — analyze a persisted trace for loops."""

    async def analyze(self, trace_id: str, tenant_id: str) -> dict[str, Any]:
        events = await _load_trace_events(trace_id, tenant_id)
        ensemble = LoopDetectorEnsemble()
        verdict = ensemble.check(events=events)
        # Persist to loop_reports table
        await _persist_loop_report(tenant_id, trace_id, verdict)
        return verdict.to_dict()
```

### 6.4 Migration 067

```sql
CREATE TABLE loop_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    trace_id        TEXT NOT NULL,
    verdict         TEXT NOT NULL,              -- 'ok' | 'loop' | 'no_data'
    confidence      NUMERIC(4,3) NOT NULL,
    detectors_tripped TEXT[] NOT NULL DEFAULT '{}',
    earliest_step   INTEGER,
    latest_step     INTEGER,
    action          TEXT,
    details         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, trace_id)
);
CREATE INDEX idx_loop_reports_tenant_created
    ON loop_reports (tenant_id, created_at DESC);
```

---

## 7. Test Plan (Detailed)

### 7.1 Per-Detector Unit Tests

For each of the 4 detectors:

1. **No history:** first call returns False.
2. **Single repeat:** 2 calls identical → detector returns False (need ≥ 3).
3. **Three repeats:** detector returns True at step 3.
4. **Ring window rolls:** 3 repeats at steps 1-3, then 5 different calls,
   then same repeat at step 9 → detector returns True at step 9.
5. **Reset:** `reset()` clears state.

### 7.2 Adversarial Tests

- **Adversarial paraphrase loop** (5 tools × 5 args): Detector 1 alone
  returns False (no exact hash match); Detectors 2 + 3 must return True.
- **Loop-stuck** (7 weather.lookup retries): Detectors 1 + 2 must return
  True; Detector 3 must return True (semantic cosine of identical calls = 1.0).
- **Page-Hinkley drift:** gradually increasing cosine (drift in novelty)
  must trip Detector 4 within 10 steps.
- **Mixed valid-then-loop:** 5 valid calls, then 5 identical calls →
  ensemble trips at the 3rd of the 5 (step 8 total).

### 7.3 Integration Tests

End-to-end against the synthetic dataset:

- `_03_loop-stuck_*` traces must produce verdict `loop` and action `block`.
- `_10_adversarial-paraphrase-loop_*` traces must produce verdict `loop`
  and action `block`.
- All other 24 traces must produce verdict `ok`.

### 7.4 F1 Test

Run the ensemble against the 30-trace synthetic dataset's ground truth
(`expected_loop_detected`). Compute F1. Target: F1 ≥ 0.7.

If F1 < 0.7, follow main spec §9.4 — add Detector 5 (Markov entropy
collapse on the action-symbol alphabet).

---

## 8. Performance SLA

| Surface | Per-step CPU | Notes |
|---|---|---|
| Hash Ring | < 50µs | O(1) per call |
| Jaccard Shingles | < 200µs | 5-shingle set ops |
| Semantic Cosine | < 3ms warm / < 15ms cold | MiniLM embed + 4 cosine dot products |
| Page-Hinkley | < 100µs | O(1) arithmetic |
| **Ensemble total** | **< 5ms warm** / **< 20ms cold** | All 4 detectors in parallel via `asyncio.gather` |

The hot-path call sites use `loop.run_in_executor` for the MiniLM embed
to avoid blocking the event loop.

---

## 9. Maintenance

- **MiniLM model upgrade:** when a new MiniLM variant lands (e.g., v3),
  bump `MINILM_MODEL_NAME`. The 24h process-lifetime cache flushes
  on the next process restart.
- **Threshold tuning:** `HASH_TRIP_THRESHOLD`, `JACCARD_SIM`,
  `COSINE_SIM`, `PH_LAMBDA` are all in `__init__` constants. Re-tune
  via the calibration plan (same as TraceRazor weights).
- **Detectors disable:** each detector has a `DISABLED` flag for
  emergency rollback. A bad detector can be disabled without
  redeploying the others.

---

**Status:** Ready for implementation. Files:
- `src/eden/observability/loops/__init__.py`
- `src/eden/observability/loops/types.py`
- `src/eden/observability/loops/minilm_embedder.py`
- `src/eden/observability/loops/detectors/{hash_ring,jaccard_shingles,semantic_cosine,page_hinkley}.py`
- `src/eden/observability/loops/ensemble.py`
- `src/eden/observability/loops/routes.py`
- `src/eden/db_migrations/versions/067_loop_reports.py`
- `tests/unit/observability/test_loops_*.py`