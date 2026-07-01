"""Semantic progress detector — the F1 ceiling breakthrough.

Per spec §19.6, replaces the proxy text-repetition counter in the
progress detector with a SEMANTIC cosine signal. Uses the same
BGE-small-en-v1.5 model already integrated (§15) to compute
cosine similarity between consecutive LLM emissions.

Key insight: the proxy-based detector only sees IDENTICAL text.
The semantic detector sees SEMANTICALLY SIMILAR text (different
words, same intent). This is what the synthetic dataset's
"redundant-repeated-context" archetype actually has: 4 LLM
emissions with different surface text but the same intent
("can you confirm the last 4 digits?").

Algorithm:
  1. Extract the assistant text from each LLM completion event.
  2. Embed each text with BGE-small (cached via SHA-256).
  3. Compute cosine between consecutive embeddings.
  4. Track max consecutive cosine (semantic repetition streak).
  5. Combined with the response-progress signal (user responses
     between repetitions):
     - High semantic cosine + no user response → STUCK (loop)
     - High semantic cosine + user response → PROGRESSING
       (redundancy, not loop)
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_3_loops.real_embeddings import get_singleton


@dataclass(frozen=True)
class SemanticProgressResult:
    """Result of the semantic progress detector."""
    is_progressing: bool
    is_stuck: bool
    max_consecutive_cosine: float    # max cosine of any 2 consecutive LLM emissions
    mean_consecutive_cosine: float   # mean cosine of consecutive LLM emissions
    consecutive_count: int           # number of consecutive LLM emissions (max)
    user_responses_in_streak: int    # user responses between LLM emissions in the streak


def _extract_assistant_text(event: TelemetryEvent) -> str:
    """Extract the assistant's response text from an LLM event."""
    body = event.response_body or {}
    bits: list[str] = []
    for c in body.get("choices") or []:
        msg = (c or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            bits.append(content)
    return " ".join(bits).strip()


def analyze_semantic_progress(
    events: list[TelemetryEvent],
    *,
    stuck_threshold: float = 0.85,
    user_observation_prefix: str = "user:",
) -> SemanticProgressResult:
    """Detect semantic-repetition streaks in LLM emissions.

    Args:
        events: full trace event list
        stuck_threshold: cosine >= this means the two LLM emissions
            are semantically equivalent (loop signature).
        user_observation_prefix: env.step observations starting with
            this prefix are treated as user responses (progress).

    Returns:
        SemanticProgressResult with is_stuck, is_progressing, and stats.
    """
    if not events:
        return SemanticProgressResult(
            is_progressing=False,
            is_stuck=False,
            max_consecutive_cosine=0.0,
            mean_consecutive_cosine=0.0,
            consecutive_count=0,
            user_responses_in_streak=0,
        )

    embedder = get_singleton()
    # Walk events, extract LLM emissions + env_step observations.
    # Track the cosine of each consecutive pair.
    cosines: list[float] = []
    # Track the longest run where cosines >= stuck_threshold.
    current_streak = 0
    max_streak = 0
    user_responses_in_streak = 0
    max_streak_user_responses = 0
    in_streak = False

    # First pass: extract all LLM texts and user observations.
    llm_texts: list[str] = []
    text_to_index: dict[str, int] = {}
    llm_event_indices: list[int] = []  # positions in events list
    for i, e in enumerate(events):
        if e.event_type == "llm.completion":
            text = _extract_assistant_text(e)
            if text:
                llm_texts.append(text)
                text_to_index[text] = len(llm_texts) - 1
                llm_event_indices.append(i)

    if len(llm_texts) < 2:
        return SemanticProgressResult(
            is_progressing=False,
            is_stuck=False,
            max_consecutive_cosine=0.0,
            mean_consecutive_cosine=0.0,
            consecutive_count=0,
            user_responses_in_streak=0,
        )

    # Batch-encode all LLM texts.
    embeddings = embedder.encode_batch(llm_texts)

    # Compute cosine between consecutive LLM emissions.
    for i in range(1, len(llm_texts)):
        sim = embedder.cosine(
            embeddings[i - 1].embedding, embeddings[i].embedding
        )
        cosines.append(sim)
        # Check if this is a high-cosine (semantic repetition) pair.
        is_repeat = sim >= stuck_threshold
        if is_repeat:
            current_streak += 1
            in_streak = True
            # Count user responses between this pair of LLM events.
            llm_i = llm_event_indices[i - 1]
            llm_j = llm_event_indices[i]
            for k in range(llm_i + 1, llm_j):
                ev = events[k]
                if ev.event_type == "env.step":
                    obs = str((ev.payload or {}).get("observation", ""))
                    if obs.startswith(user_observation_prefix):
                        user_responses_in_streak += 1
        else:
            # Streak broken. Update max if it was a no-progress streak.
            if in_streak and current_streak > max_streak:
                max_streak = current_streak
                max_streak_user_responses = user_responses_in_streak
            current_streak = 0
            user_responses_in_streak = 0
            in_streak = False
    # Final update if the trace ended in a streak.
    if in_streak and current_streak > max_streak:
        max_streak = current_streak
        max_streak_user_responses = user_responses_in_streak

    # Compute mean.
    mean_cos = sum(cosines) / len(cosines) if cosines else 0.0
    max_cos = max(cosines) if cosines else 0.0

    # Decision: stuck iff streak ≥ 2 AND no user responses in streak.
    is_stuck = max_streak >= 2 and max_streak_user_responses == 0
    is_progressing = max_streak >= 2 and max_streak_user_responses > 0

    return SemanticProgressResult(
        is_progressing=is_progressing,
        is_stuck=is_stuck,
        max_consecutive_cosine=max_cos,
        mean_consecutive_cosine=mean_cos,
        consecutive_count=max_streak,
        user_responses_in_streak=max_streak_user_responses,
    )


def semantic_progress_filter_loop_verdict(
    events: list[TelemetryEvent],
    cosine_loop_detected: bool,
    *,
    stuck_threshold: float = 0.85,
) -> bool:
    """Combine cosine loop detection with semantic progress signal.

    Returns True if the trace should be flagged as a LOOP.

    Decision:
      - cosine_loop_detected = False → no LOOP
      - cosine_loop_detected = True, semantic_progress.is_stuck = True → LOOP
      - cosine_loop_detected = True, semantic_progress.is_progressing = True → NO LOOP
      - cosine_loop_detected = True, semantic_progress equivocal → LOOP (default)
    """
    if not cosine_loop_detected:
        return False
    progress = analyze_semantic_progress(events, stuck_threshold=stuck_threshold)
    if progress.is_stuck:
        return True
    if progress.is_progressing:
        return False
    # Equivocal: default to LOOP (current behaviour).
    return True


__all__ = [
    "SemanticProgressResult",
    "analyze_semantic_progress",
    "semantic_progress_filter_loop_verdict",
]