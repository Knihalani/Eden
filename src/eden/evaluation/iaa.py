"""Inter-annotator agreement helpers (Cohen's κ) for labeling queues."""

from __future__ import annotations

from collections import Counter
from typing import Any


def cohen_kappa(labels_a: list[str], labels_b: list[str]) -> float:
    """Cohen's kappa for two equal-length label sequences."""
    n = min(len(labels_a), len(labels_b))
    if n == 0:
        return 0.0
    a = labels_a[:n]
    b = labels_b[:n]
    agree = sum(1 for i in range(n) if a[i] == b[i])
    po = agree / n
    cats = set(a) | set(b)
    ca = Counter(a)
    cb = Counter(b)
    pe = sum((ca[c] / n) * (cb[c] / n) for c in cats)
    if abs(1.0 - pe) < 1e-12:
        return 1.0 if po == 1.0 else 0.0
    return (po - pe) / (1.0 - pe)


def iaa_from_annotation_pairs(
    pairs: list[tuple[str, str]],
) -> dict[str, Any]:
    """Compute κ from (annotator_a_label, annotator_b_label) pairs."""
    if not pairs:
        return {"kappa": 0.0, "n": 0, "agreement_rate": 0.0}
    a = [p[0] for p in pairs]
    b = [p[1] for p in pairs]
    n = len(pairs)
    agree = sum(1 for i in range(n) if a[i] == b[i])
    return {
        "kappa": round(cohen_kappa(a, b), 4),
        "n": n,
        "agreement_rate": round(agree / n, 4),
    }


__all__ = ["cohen_kappa", "iaa_from_annotation_pairs"]
