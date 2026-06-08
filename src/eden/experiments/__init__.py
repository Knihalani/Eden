"""Platform-wide A/B testing framework (closes §8.4)."""
from __future__ import annotations

from eden.experiments.service import (
    Experiment,
    ExperimentResult,
    Variant,
    analyse,
    assign_variant,
    recommend_winner,
    record_outcome,
    reset_outcomes,
    two_proportion_z_test,
)

__all__ = [
    "Experiment",
    "ExperimentResult",
    "Variant",
    "analyse",
    "assign_variant",
    "recommend_winner",
    "record_outcome",
    "reset_outcomes",
    "two_proportion_z_test",
]
