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


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def hashed_term_vector(text: str, *, dims: int = 64) -> list[float]:
    """Deterministic, L2-normalized bag-of-words hashing vector.

    Splits ``text`` into lowercase word tokens and hashes each token into
    one of ``dims`` buckets (via :func:`stable_bucket`), incrementing that
    bucket's count. Cosine similarity between two such vectors tracks real
    token overlap between the source texts -- unlike hashing the *whole*
    string to a single seed, which produces near-uncorrelated noise per
    document (this was the root cause of a signal-clustering bug where
    88.7% of unrelated rows collapsed into one mega-cluster: OPT-2).

    Used as the embed fallback in ``eden.signals.clusterer._embed`` when no
    real semantic embedder is installed.
    """
    if dims <= 0:
        return []
    vec = [0.0] * dims
    for tok in _TOKEN_RE.findall((text or "").lower()):
        vec[stable_bucket(tok, dims)] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec
