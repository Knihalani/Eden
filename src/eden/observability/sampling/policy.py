"""N16 — intelligence-aware tail sampling policy.

Deterministic keep rules (P0/P1 intelligence signals) run before the
probabilistic fallback. Profiles map to keep rates for the fallback only:

  * ``full``       — 100% (sampling effectively off)
  * ``balanced``   — ~15% of non-signal traces (~18% all-in on mixed traffic)
  * ``aggressive`` — ~5% of non-signal traces

Never sample away traces that carry any P0–P1 keep signal.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from enum import Enum
from typing import Literal

SamplingProfile = Literal["full", "balanced", "aggressive"]

PROFILE_KEEP_RATES: dict[str, float] = {
    "full": 1.0,
    "balanced": 0.15,
    "aggressive": 0.05,
}


def profile_keep_rate(profile: str) -> float:
    """Return the probabilistic keep rate for a named profile.

    Unknown names fall back to ``full`` (100% keep) so a typo cannot
    silently start dropping traffic under soft-launch defaults.
    """
    return PROFILE_KEEP_RATES.get(profile, PROFILE_KEEP_RATES["full"])


@dataclass(frozen=True)
class KeepSignals:
    """Intelligence / outcome flags available at sampling decision time."""

    has_error: bool = False
    is_loop: bool = False
    has_tool_error: bool = False
    has_stumble: bool = False
    has_judge_failure: bool = False
    has_stat_gate_fail: bool = False
    has_mcp_auth_failure: bool = False
    is_high_cost: bool = False
    force_trace: bool = False
    duration_ms: float = 0.0


@dataclass(frozen=True)
class SamplingDecision:
    """Result of an N16 keep/drop decision."""

    keep: bool
    reason: str
    rule_matched: str | None
    profile: str
    metrics_only: bool = False


class KeepPriority(str, Enum):
    FORCE = "force_trace"
    LOOP = "loop"
    ERROR = "error"
    TOOL_ERROR = "tool_error"
    STAT_GATE = "stat_gate_fail"
    STUMBLE = "stumble"
    JUDGE_FAIL = "judge_failure"
    MCP_AUTH = "mcp_auth_failure"
    HIGH_COST = "high_cost"
    SLOW = "slow"
    PROBABILISTIC = "probabilistic"


@dataclass
class IntelligenceAwareSamplingPolicy:
    """Product sampling policy (N16).

    P0/P1 signal matches always keep. Otherwise apply the profile's
    probabilistic keep rate. When ``enabled`` is False the policy keeps
    everything (safe rollback).
    """

    profile: SamplingProfile = "full"  # soft-launch default; ops set balanced
    enabled: bool = True
    slow_threshold_ms: float = 5_000.0
    keep_rate_override: float | None = None
    rng_seed: int | None = None

    def __post_init__(self) -> None:
        self._rng = random.Random(self.rng_seed)

    @property
    def keep_rate(self) -> float:
        if self.keep_rate_override is not None:
            return float(self.keep_rate_override)
        return profile_keep_rate(self.profile)

    def decide(self, signals: KeepSignals) -> SamplingDecision:
        profile = self.profile if self.enabled else "full"
        if not self.enabled or self.profile == "full" or self.keep_rate >= 1.0:
            return SamplingDecision(
                keep=True,
                reason="sampling disabled or full profile",
                rule_matched=None if not self.enabled else "full",
                profile=profile,
                metrics_only=False,
            )

        # Priority order mirrors n16-intelligence-aware-tail-sampling.md §2.
        if signals.force_trace:
            return self._keep(KeepPriority.FORCE, "forced by caller", profile)
        if signals.is_loop:
            return self._keep(KeepPriority.LOOP, "loop verdict", profile)
        if signals.has_error:
            return self._keep(KeepPriority.ERROR, "error outcome", profile)
        if signals.has_tool_error:
            return self._keep(KeepPriority.TOOL_ERROR, "tool error span", profile)
        if signals.has_stat_gate_fail:
            return self._keep(KeepPriority.STAT_GATE, "stat gate P0 fail", profile)
        if signals.has_stumble:
            return self._keep(KeepPriority.STUMBLE, "stumble detected", profile)
        if signals.has_judge_failure:
            return self._keep(KeepPriority.JUDGE_FAIL, "judge failure", profile)
        if signals.has_mcp_auth_failure:
            return self._keep(KeepPriority.MCP_AUTH, "mcp auth failure", profile)
        if signals.is_high_cost:
            return self._keep(KeepPriority.HIGH_COST, "high cost outlier", profile)
        if signals.duration_ms > self.slow_threshold_ms:
            return self._keep(
                KeepPriority.SLOW,
                f"slow ({signals.duration_ms}ms)",
                profile,
            )

        if self._rng.random() < self.keep_rate:
            return SamplingDecision(
                keep=True,
                reason="probabilistic sample",
                rule_matched=KeepPriority.PROBABILISTIC.value,
                profile=profile,
                metrics_only=False,
            )
        return SamplingDecision(
            keep=False,
            reason="sampled_out",
            rule_matched=None,
            profile=profile,
            metrics_only=True,
        )

    @staticmethod
    def _keep(rule: KeepPriority, reason: str, profile: str) -> SamplingDecision:
        return SamplingDecision(
            keep=True,
            reason=reason,
            rule_matched=rule.value,
            profile=profile,
            metrics_only=False,
        )

    def otel_keep_attributes(self, signals: KeepSignals) -> dict[str, str]:
        """Attribute tags for the OTel edge ``tail_sampling`` processor."""
        decision = self.decide(signals)
        attrs = {
            "eden.sampling.profile": self.profile,
            "eden.keep": "true" if decision.keep else "false",
        }
        if decision.rule_matched:
            attrs["eden.keep_rule"] = decision.rule_matched
        if signals.is_loop:
            attrs["eden.loop_verdict"] = "true"
        if signals.force_trace:
            attrs["eden.force_trace"] = "true"
        return attrs


_policy: IntelligenceAwareSamplingPolicy | None = None


def get_sampling_policy() -> IntelligenceAwareSamplingPolicy:
    """Return the process-wide N16 policy (settings-backed on first call)."""
    global _policy
    if _policy is not None:
        return _policy
    try:
        from eden.config import get_settings

        s = get_settings()
        # Soft-launch default is full (100% keep). Unknown profiles fall
        # back to full — never to balanced — so a typo cannot silently
        # start dropping traffic.
        profile = getattr(s, "sampling_profile", "full") or "full"
        if profile not in PROFILE_KEEP_RATES:
            profile = "full"
        enabled = bool(getattr(s, "sampling_enabled", True))
        override = getattr(s, "probabilistic_sample_rate", None)
        keep_rate_override = None
        if override is not None and float(override) < 1.0:
            # Explicit rate overrides profile fallback only when not "full".
            keep_rate_override = float(override)
        _policy = IntelligenceAwareSamplingPolicy(
            profile=profile,  # type: ignore[arg-type]
            enabled=enabled,
            keep_rate_override=keep_rate_override,
        )
    except Exception:
        _policy = IntelligenceAwareSamplingPolicy()
    return _policy


def reset_sampling_policy() -> None:
    """Clear the singleton (tests)."""
    global _policy
    _policy = None
