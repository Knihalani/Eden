"""Response-progress signal for loop vs redundancy disambiguation.

Per spec §15.6 mitigation path (a): distinguish "agent stuck in a loop"
from "agent legitimately re-asking the user the same question".

Signal:
  - LOOP if: same agent call repeated 3+ times AND no new user/tool
    response between repetitions
  - REDUNDANCY if: same agent call repeated 3+ times BUT new user/
    tool response between each repetition (agent is making progress
    by waiting for input)

Implementation:
  - Inspect event sequence between consecutive identical LLM emissions
  - If there are env_step or tool_call events with new content between
    consecutive repetitions → progress → not a loop
  - Otherwise → stuck → loop
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from eden.observability.telemetry_collector import TelemetryEvent


@dataclass(frozen=True)
class ProgressVerdict:
    """Result of the response-progress signal."""
    is_progressing: bool   # True if the trace shows progress (redundancy)
    is_stuck: bool          # True if the trace shows no progress (loop)
    identical_repetitions: int
    responses_between: int


def analyze_progress(events: list[TelemetryEvent]) -> ProgressVerdict:
    """Walk events to detect stuck vs progressing patterns.

    Heuristic:
      - Track the longest run of IDENTICAL CONSECUTIVE LLM emissions
        (count of `Let me check.` repeated N times in a row).
      - Track whether a SUCCESSFUL tool_call or env_step occurred between
        the LAST two identical LLM emissions.
        - env_step with NEW observation (different from prior observation)
          → progress (user responded with new info).
        - successful tool_call (outcome='success') with NEW response
          → progress (got a new useful result).
        - failed tool_call or same env_step observation → still stuck.

    Decision:
      - 3+ identical LLM emissions AND no NEW successful response
        between repetitions → stuck.
      - 3+ identical LLM emissions BUT a NEW successful response
        between repetitions → progressing (agent asking same Q but
        getting new info).
      - < 3 identical emissions → neither.
    """
    if not events:
        return ProgressVerdict(False, False, 0, 0)

    # Walk in timestamp order. Track LLM emissions and intervening events.
    last_llm_content: str | None = None
    last_llm_seen = False
    current_repetition = 0
    max_repetitions = 0
    last_env_obs: str | None = None
    last_tool_outcome: str | None = None
    new_response_between_repetitions = False

    for event in events:
        if event.event_type == "llm.completion":
            content = _extract_content(event)
            if last_llm_seen and content == last_llm_content:
                current_repetition += 1
                if current_repetition > max_repetitions:
                    max_repetitions = current_repetition
                # Check if we saw any NEW response between repetitions.
                # Reset for the next repetition.
                last_env_obs = None
                last_tool_outcome = None
            else:
                last_llm_content = content
                last_llm_seen = True
                current_repetition = 1
                last_env_obs = None
                last_tool_outcome = None
        elif event.event_type == "env.step":
            obs = (event.payload or {}).get("observation")
            obs_str = str(obs) if obs else ""
            # Only USER responses (e.g. "user: 8842") count as progress.
            # Agent timeouts, errors, "aborted after..." etc. are NOT
            # user responses — they don't constitute progress.
            if obs_str and obs_str.startswith("user"):
                # New user observation → progress.
                last_env_obs = obs_str
                if current_repetition >= 1:
                    new_response_between_repetitions = True
            # Non-user observations (timeout, error, aborted) are NOT progress.
        elif event.event_type == "tool.call":
            outcome = event.outcome or ""
            if outcome == "success" and last_tool_outcome != "success":
                # New successful tool call → progress.
                last_tool_outcome = outcome
                if current_repetition >= 1:
                    new_response_between_repetitions = True
            elif outcome:
                last_tool_outcome = outcome

    # If we have 3+ identical LLM emissions anywhere AND NO new
    # successful response between repetitions → stuck.
    is_stuck = max_repetitions >= 3 and not new_response_between_repetitions
    is_progressing = max_repetitions >= 3 and new_response_between_repetitions

    return ProgressVerdict(
        is_progressing=is_progressing,
        is_stuck=is_stuck,
        identical_repetitions=max_repetitions,
        responses_between=1 if new_response_between_repetitions else 0,
    )


def _extract_content(event: TelemetryEvent) -> str:
    """Extract content hash from an LLM event."""
    body = event.response_body or {}
    bits = []
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


def progress_filter_loop_verdict(
    events: list[TelemetryEvent],
    cosine_loop_detected: bool,
) -> bool:
    """Combine cosine loop detection with progress signal.

    Returns True if the trace should be flagged as a LOOP (after
    progress filtering).

    Decision:
      - cosine_loop_detected = False → no LOOP
      - cosine_loop_detected = True, progress.is_stuck = True → LOOP
      - cosine_loop_detected = True, progress.is_progressing = True → NO LOOP
      - cosine_loop_detected = True, progress equivocal → LOOP (default)
    """
    if not cosine_loop_detected:
        return False
    progress = analyze_progress(events)
    if progress.is_stuck:
        return True
    if progress.is_progressing:
        # Agent is asking the same question but the user is responding
        # differently → redundancy, not a loop.
        return False
    # Equivocal: default to LOOP (current behaviour).
    return True


__all__ = [
    "ProgressVerdict",
    "analyze_progress",
    "progress_filter_loop_verdict",
]