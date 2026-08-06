"""Deterministic hashing for anything that must survive a process restart.

Python's built-in ``hash()`` is **salted per process** for ``str`` and
``bytes`` (PEP 456). Two workers, or the same worker after a restart, return
different values for the same input::

    $ python -c "print(hash('trace-abc') % 1000)"   # 62
    $ python -c "print(hash('trace-abc') % 1000)"   # 441

That is exactly the property you want for an in-memory dict and exactly the
wrong one for anything persisted, sharded, bucketed, sampled or seeded. Eden
used ``hash()`` for all of those: k-fold dataset assignment, canary cohort
seeds, embedding vectors, cluster-id derivation and experiment RNG seeds. Each
silently reshuffled on every deploy, so a trace could land in a different fold,
a canary could flip cohort, and "deterministic" embeddings differed between two
workers serving the same request.

``blake2b`` with a fixed digest size is stable across processes, releases and
machines, and is already the convention in ``predictive/_common.py``; this
module makes it available everywhere so the built-in is never the easy choice.

Use ``stable_hash`` for a raw integer, ``stable_bucket`` to land in
``[0, n)``, and ``stable_seed`` to seed an RNG reproducibly.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

__all__ = ["hashed_term_vector", "stable_bucket", "stable_hash", "stable_seed"]

_TOKEN_RE = re.compile(r"[a-z0-9]+")

#: 8 bytes — a 64-bit space, matching the existing ``_hash_bucket`` convention
#: and far beyond the collision pressure of any bucketing Eden does.
_DIGEST_SIZE = 8


def _to_bytes(value: Any) -> bytes:
    """Render ``value`` as bytes deterministically.

    Tuples are joined with a separator that cannot appear in the rendered
    parts, so ``("a", "bc")`` and ``("ab", "c")`` do not collide.
    """
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (tuple, list)):
        return b"\x00".join(_to_bytes(v) for v in value)
    return repr(value).encode("utf-8")


def stable_hash(value: Any) -> int:
    """Return a deterministic non-negative 64-bit hash of ``value``.

    Unlike the built-in ``hash()``, the result is identical across processes,
    restarts and machines.
    """
    digest = hashlib.blake2b(_to_bytes(value), digest_size=_DIGEST_SIZE).digest()
    return int.from_bytes(digest, "big")


def stable_bucket(value: Any, n_buckets: int) -> int:
    """Map ``value`` deterministically into ``[0, n_buckets)``.

    Returns 0 when ``n_buckets`` is not positive, so a caller that computed a
    bucket count from an empty collection cannot raise ZeroDivisionError on the
    hot path.
    """
    if n_buckets <= 0:
        return 0
    return stable_hash(value) % n_buckets


def stable_seed(value: Any, *, bits: int = 32) -> int:
    """Return a reproducible RNG seed derived from ``value``.

    ``random.Random(stable_seed(x))`` gives the same stream on every process,
    which is what "deterministic assignment" in canary rollouts and experiment
    recommendations always assumed and never had.
    """
    return stable_hash(value) % (1 << bits)


def hashed_term_vector(text: str, *, dims: int = 64) -> list[float]:
    """Deterministic, L2-normalized *hashed bag-of-words* vector.

    This is the "feature hashing" trick: each token is bucketed into one of
    ``dims`` slots via :func:`stable_bucket` and accumulated by term
    frequency. It is a legitimate fallback content-similarity measure when no
    semantic embedding model is available — two texts that share vocabulary
    land in overlapping buckets and get genuinely higher cosine similarity
    (a Jaccard/TF-overlap style signal), unlike hashing the *whole string*
    into a single scalar and deriving a vector from it, which produces
    near-uncorrelated-looking vectors for related text and, worse, can
    produce spuriously *high* similarity between unrelated text if the
    per-dimension derivation is not independent per input (see the
    ``signal_clusterer`` mega-cluster bug this replaced: OPT-2).

    Not a substitute for a real embedding model — it only captures lexical
    overlap, not semantics/paraphrase — but it is non-degenerate: distinct
    vocabularies reliably yield low cosine similarity and shared vocabularies
    reliably yield high cosine similarity.

    Used as the embed fallback in ``eden.signals.clusterer._embed`` when no
    real semantic embedder is installed.
    """
    vec = [0.0] * dims
    if not text or dims <= 0:
        return vec
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        return vec
    for tok in tokens:
        vec[stable_bucket(tok, dims)] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec
