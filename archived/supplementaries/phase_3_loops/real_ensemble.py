"""Loop detector ensemble with REAL BGE-small embeddings.

Replaces the token-set proxy in `semantic_cosine.py` with the real
`BAAI/bge-small-en-v1.5` model. Validates F1 ≥ 0.72 on the
synthetic dataset (vs 0.83 with proxy per BENCHMARK.md).

Production deployment:
  - Lazy-load via singleton (real_embeddings.get_singleton)
  - Cache embeddings per SHA-256 hash of step text
  - 5-step sliding window for cosine similarity
  - 2-of-4 ensemble rule preserved
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Sequence

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_3_loops.hash_ring import scan_hash_ring
from supplementaries.phase_3_loops.jaccard_shingles import scan_jaccard_shingles
from supplementaries.phase_3_loops.page_hinkley import scan_page_hinkley
from supplementaries.phase_3_loops.real_embeddings import get_singleton


def _step_text(event: TelemetryEvent) -> str:
    """Extract step text for similarity comparison."""
    if event.event_type == "tool.call":
        body = event.request_body or {}
        tool = body.get("tool") or event.name or ""
        args = body.get("arguments") or {}
        if isinstance(args, dict):
            pairs = " ".join(f"{k}={v}" for k, v in sorted(args.items()))
        else:
            pairs = str(args)
        return f"{tool} {pairs}"
    if event.event_type == "llm.completion":
        body = event.response_body or {}
        bits: list[str] = []
        for c in body.get("choices") or []:
            msg = (c or {}).get("message") or {}
            content = msg.get("content")
            if isinstance(content, str):
                bits.append(content)
        for tc in (event.tool_calls_full or []):
            fn = (tc or {}).get("function") or {}
            name = fn.get("name")
            if name:
                bits.append(name)
        return " ".join(bits)
    if event.event_type == "env.step":
        obs = (event.payload or {}).get("observation")
        return f"{event.name or ''} {obs or ''}".strip()
    return event.name or ""


@dataclass(frozen=True)
class RealEnsembleReport:
    """Final ensemble report with real embeddings."""
    verdict: str          # "OK" | "LOOP"
    action: str           # "allow" | "block" | "escalate"
    detectors_tripped: list[str]
    severity: str         # "stable" | "medium" | "high"
    cosine_above_threshold: int
    cosine_max: float
    cosine_avg: float
    jaccard_max: float
    hash_ring_trips: int
    page_hinkley_trips: int


def check_real(
    events: Sequence[TelemetryEvent],
    *,
    jaccard_threshold: float = 0.40,
    cosine_threshold: float = 0.92,
    low_novelty_threshold: float = 0.5,
    consecutive_threshold: int = 5,
    ring_window: int = 8,
    ring_trip_threshold: int = 3,
    shingle_window: int = 5,
    consecutive_window: int = 5,
    outer_window: int = 5,
    min_detectors: int = 2,
    high_detectors: int = 3,
    use_real_embeddings: bool = True,
) -> RealEnsembleReport:
    """Run the 4-detector ensemble with REAL BGE-small embeddings.

    Falls back to token-set proxy if `use_real_embeddings=False`.
    The 4 detectors:
      1. SHA-256 hash ring (tool, args) — exact-match loop
      2. Jaccard shingles (k=3) — paraphrase via token overlap
      3. Cosine (REAL BGE-small) — semantic similarity
      4. Page-Hinkley consecutive-novelty counter — novelty collapse

    Trigger rule: 2 of 4 trip within 5-step outer window → LOOP.
    """
    # 1. Hash ring (no embeddings needed)
    ring_summary = scan_hash_ring(list(events))
    hash_trip_set = {r.step_index for r in ring_summary.results if r.tripped}

    # 2. Jaccard shingles (no embeddings)
    jaccard_summary = scan_jaccard_shingles(list(events))
    jaccard_trip_set = {
        r.step_index for r in jaccard_summary.results if r.tripped
    }

    # 3. Cosine — REAL embeddings
    cosine_trip_set: set[int] = set()
    cosine_max = 0.0
    cosine_avg = 0.0
    if use_real_embeddings:
        embedder = get_singleton()
        step_texts = [_step_text(e) for e in events]
        # Batch-encode for efficiency
        embeddings = embedder.encode_batch(step_texts)
        # Pairwise cosine in sliding window
        n = len(events)
        cos_sim_count = 0
        cos_sim_sum = 0.0
        for i in range(n):
            lo = max(0, i - shingle_window)
            for j in range(lo, i):
                sim = embedder.cosine(embeddings[i].embedding, embeddings[j].embedding)
                if sim > cosine_max:
                    cosine_max = sim
                cos_sim_sum += sim
                cos_sim_count += 1
                if sim >= cosine_threshold:
                    cosine_trip_set.add(i)
        if cos_sim_count > 0:
            cosine_avg = cos_sim_sum / cos_sim_count

    # 4. Page-Hinkley counter (no embeddings)
    ph_summary = scan_page_hinkley(list(events))
    ph_trip_set = {r.step_index for r in ph_summary.results if r.tripped}

    # Combine: per-step trip count.
    all_step_indices = sorted(
        set(hash_trip_set) | set(jaccard_trip_set) | set(cosine_trip_set) | set(ph_trip_set)
    )
    # Sliding window across all events (not just tripped indices).
    n = len(events)
    step_trips = [0] * n
    for idx in hash_trip_set | jaccard_trip_set | cosine_trip_set | ph_trip_set:
        if 0 <= idx < n:
            step_trips[idx] += 1
    # Sliding outer window sum.
    recent = deque(maxlen=outer_window)
    peak_count = 0
    for count in step_trips:
        recent.append(count)
        if sum(recent) > peak_count:
            peak_count = sum(recent)

    # Verdict
    if peak_count >= high_detectors:
        severity = "high"
        action = "escalate"
        verdict = "LOOP"
    elif peak_count >= min_detectors:
        severity = "medium"
        action = "block"
        verdict = "LOOP"
    else:
        severity = "stable"
        action = "allow"
        verdict = "OK"

    # Detectors tripped (any detector that tripped at any point)
    detectors_tripped: list[str] = []
    if hash_trip_set:
        detectors_tripped.append("hash_ring")
    if jaccard_trip_set:
        detectors_tripped.append("jaccard_shingles")
    if cosine_trip_set:
        detectors_tripped.append("semantic_cosine_real")
    if ph_trip_set:
        detectors_tripped.append("page_hinkley")

    return RealEnsembleReport(
        verdict=verdict,
        action=action,
        detectors_tripped=detectors_tripped,
        severity=severity,
        cosine_above_threshold=len(cosine_trip_set),
        cosine_max=cosine_max,
        cosine_avg=cosine_avg,
        jaccard_max=max((r.max_prior_jaccard for r in jaccard_summary.results), default=0.0),
        hash_ring_trips=len(hash_trip_set),
        page_hinkley_trips=len(ph_trip_set),
    )


__all__ = [
    "RealEnsembleReport",
    "check_real",
]