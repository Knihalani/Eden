"""Client-side sampling mirroring N16 profiles (full/balanced/aggressive)."""

from __future__ import annotations

import os
import random
from dataclasses import dataclass
from typing import Literal

SamplingProfile = Literal["full", "balanced", "aggressive"]

PROFILE_KEEP_RATES: dict[str, float] = {
    "full": 1.0,
    "balanced": 0.15,
    "aggressive": 0.05,
}


@dataclass(frozen=True)
class SampleSignals:
    has_error: bool = False
    force: bool = False
    duration_ms: float = 0.0


@dataclass
class ClientSampler:
    """Keep-errors + profile probabilistic sampling for SDK enqueue."""

    profile: SamplingProfile = "full"
    keep_errors: bool = True
    slow_threshold_ms: float = 5_000.0
    enabled: bool = True
    rng_seed: int | None = None

    def __post_init__(self) -> None:
        self._rng = random.Random(self.rng_seed)

    @property
    def keep_rate(self) -> float:
        return PROFILE_KEEP_RATES.get(self.profile, 1.0)

    def should_keep(self, signals: SampleSignals | None = None) -> bool:
        signals = signals or SampleSignals()
        if not self.enabled or self.profile == "full" or self.keep_rate >= 1.0:
            return True
        if signals.force:
            return True
        if self.keep_errors and signals.has_error:
            return True
        if signals.duration_ms > self.slow_threshold_ms:
            return True
        return self._rng.random() < self.keep_rate


def sampler_from_env() -> ClientSampler:
    raw = (os.getenv("EDEN_SAMPLING_PROFILE") or "full").strip().lower()
    profile: SamplingProfile = (
        raw if raw in PROFILE_KEEP_RATES else "full"  # type: ignore[assignment]
    )
    keep_errors = (os.getenv("EDEN_SAMPLE_KEEP_ERRORS") or "1").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    enabled = (os.getenv("EDEN_SAMPLING_ENABLED") or "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }
    return ClientSampler(profile=profile, keep_errors=keep_errors, enabled=enabled)
