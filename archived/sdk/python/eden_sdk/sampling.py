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
    """Keep-errors + profile probabilistic sampling for SDK enqueue.

    ``client_probabilistic_sampling`` (default ``False``) is the SDK
    x server compounding guard. Before it existed, setting
    ``EDEN_SAMPLING_PROFILE=balanced`` on *just the server* (the
    documented, intended way to enable N16) also silently sampled at
    ~15% on any SDK that happened to read the same env var — because
    ``configure()``/``_from_env()`` pick up ``EDEN_SAMPLING_PROFILE``
    unconditionally. Two independent ~15% gates compound
    multiplicatively (0.15 x 0.15 = 2.25% effective keep), not
    additively, with nothing in either layer's logs to explain the
    gap. With this flag left at its default, a non-``full`` profile on
    the client applies ONLY the deterministic force-keep rules
    (error / slow / ``force_trace``) and otherwise keeps everything —
    the probabilistic drop is left entirely to the server, so setting
    the profile on the server alone behaves exactly as documented.
    Set ``EDEN_CLIENT_PROBABILISTIC_SAMPLING=1`` to opt back into
    client-side probabilistic dropping (e.g. for a pure-SDK deployment
    with no server-side N16 gate at all).
    """

    profile: SamplingProfile = "full"
    keep_errors: bool = True
    slow_threshold_ms: float = 5_000.0
    enabled: bool = True
    client_probabilistic_sampling: bool = False
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
        if not self.client_probabilistic_sampling:
            # SDK x server compounding guard — see the class docstring.
            # Force/error/slow already ran above; nothing left to do
            # but leave the probabilistic decision to the server.
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
    # Default OFF — see ``ClientSampler``'s docstring for why. Opt in
    # explicitly only for deployments with no server-side N16 gate.
    client_probabilistic_sampling = (
        os.getenv("EDEN_CLIENT_PROBABILISTIC_SAMPLING") or "0"
    ).strip().lower() in {"1", "true", "yes", "on"}
    return ClientSampler(
        profile=profile,
        keep_errors=keep_errors,
        enabled=enabled,
        client_probabilistic_sampling=client_probabilistic_sampling,
    )
