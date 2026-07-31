"""One blake2b construction in the tree, and the same buckets as before.

``eden.util.stable_hash`` arrived to replace the builtin ``hash()`` in the
places where a process-salted value was being persisted or bucketed. It landed
alongside three hand-rolled blake2b implementations that already did the same
thing:

* ``predictive/_common.py::_hash_bucket`` — ``blake2b(text, 8) % n_buckets``
* ``predictive/risk.py::_hash_bucket_inline`` — a byte-for-byte copy of it with
  ``% 64`` hard-coded, justified in its own docstring by not wanting to depend
  on the helper's lazy import
* ``observability/sampling/policy.py::trace_keep_position`` —
  ``blake2b(salt + trace_id, 8) / 2**64``

Four implementations of one idea is how they drift. The concrete hazard was
already present: ``_hash_bucket`` takes ``n_buckets`` and defaults to
``EMBEDDING_BUCKETS``, while its copy hard-coded ``64``, so changing that
constant would have left ``risk.py``'s PSI computed over a different bucket
space than ``drift.py``'s — two "embedding drift" numbers that are not
comparable, with nothing to signal it.

All three now delegate. **This is a refactor, so the burden is proving nothing
moved.** Bucket assignments are persisted, compared across time windows, and
in the sampling case decide which traces are kept — a shifted mapping would
show up as drift that did not happen, or as a sampled corpus that silently
changes identity. The golden values below were captured by running the *old*
implementations before they were touched, and are asserted against the new
ones.

The empty-string case is the one place the answers legitimately differ, and it
is pinned in both directions.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from eden.observability.sampling.policy import trace_keep_position
from eden.predictive import risk
from eden.predictive._common import EMBEDDING_BUCKETS, _hash_bucket
from eden.util.stable_hash import stable_bucket, stable_hash

SRC = Path(__file__).resolve().parents[3] / "src" / "eden"

#: Captured from the pre-refactor ``_hash_bucket`` / ``_hash_bucket_inline``
#: (identical outputs), which both hashed with ``blake2b(digest_size=8)`` and
#: reduced modulo 64. Includes non-ASCII, because the encoding step is the
#: easiest thing to get subtly wrong, and a 500-character body, because that is
#: what the drift path actually passes.
GOLDEN_BUCKETS: dict[str, int] = {
    "a": 47,
    "hello world": 16,
    "trace-abc": 13,
    "ünïcødé ✓": 56,
    "x" * 500: 8,
    "{}": 19,
}

#: Captured from the pre-refactor ``trace_keep_position``. Seeds included
#: because ``rng_seed`` is the documented rotation knob: if salting changed
#: shape, rotation would stop meaning what the docstring says.
GOLDEN_POSITIONS: dict[tuple[str, int | None], float] = {
    ("trace-abc", None): 0.07918342767444032,
    ("trace-abc", 0): 0.43469277425461145,
    ("trace-abc", 7): 0.8115588589594094,
    ("t-1", None): 0.7627154043735623,
    ("t-1", 0): 0.4257196282957234,
    ("t-1", 7): 0.40789538900157896,
    ("", None): 0.8931675160897388,
    ("", 0): 0.2506975831573811,
    ("", 7): 0.8887222450452638,
}


class TestNothingMoved:
    @pytest.mark.parametrize(
        ("text", "bucket"),
        list(GOLDEN_BUCKETS.items()),
        ids=["ascii", "phrase", "trace-id", "non-ascii", "long-body", "json"],
    )
    def test_bucket_assignments_are_unchanged(self, text: str, bucket: int) -> None:
        assert _hash_bucket(text) == bucket, (
            f"_hash_bucket({text[:30]!r}...) moved from {bucket} to "
            f"{_hash_bucket(text)}. Bucket assignments feed PSI across time "
            "windows, so a shift makes every historical comparison read as "
            "topic drift that did not occur."
        )

    @pytest.mark.parametrize(("key", "position"), list(GOLDEN_POSITIONS.items()))
    def test_keep_positions_are_unchanged(
        self, key: tuple[str, int | None], position: float
    ) -> None:
        trace_id, seed = key
        assert trace_keep_position(trace_id, seed) == position, (
            "the trace -> keep-position mapping moved; the set of traces kept "
            "at a given rate would change identity"
        )

    def test_the_helper_and_the_shared_function_agree(self) -> None:
        """Belt and braces over a wider corpus than the golden table."""
        for i in range(500):
            text = f"body-{i}-{'z' * (i % 17)}"
            assert _hash_bucket(text, EMBEDDING_BUCKETS) == stable_bucket(
                text, EMBEDDING_BUCKETS
            )


class TestTheEmptyStringGuard:
    """The one intentional difference, pinned from both sides."""

    def test_empty_text_gets_its_own_bucket(self) -> None:
        assert _hash_bucket("") == 0

    def test_and_that_is_not_what_hashing_would_give(self) -> None:
        """Otherwise the guard looks redundant and invites deletion.

        ``blake2b(b"") % 64`` is 52, an ordinary-looking bucket. Without the
        guard, every trace with a missing body would pile into bucket 52 and be
        indistinguishable from a genuine topic cluster there.
        """
        assert stable_bucket("", EMBEDDING_BUCKETS) == 52
        assert stable_bucket("", EMBEDDING_BUCKETS) != _hash_bucket("")


class TestTheDuplicatesAreGone:
    def test_risk_no_longer_carries_its_own_copy(self) -> None:
        assert not hasattr(risk, "_hash_bucket_inline"), (
            "predictive/risk.py has re-grown its private blake2b copy. It "
            "hard-coded '% 64' while the shared helper takes n_buckets, so the "
            "two silently disagree the moment EMBEDDING_BUCKETS changes."
        )

    def test_risk_uses_the_shared_helper(self) -> None:
        """Absence is not enough — it could have been renamed."""
        from eden.predictive import _common

        assert risk._hash_bucket is _common._hash_bucket

    def test_risk_and_drift_bucket_into_the_same_space(self) -> None:
        """The failure the duplication was actually set up to cause.

        ``risk.py`` and ``drift.py`` both compute PSI over these buckets and
        both present the result as "embedding drift". ``risk.py`` used to pass
        a literal ``n_buckets=64`` to ``_psi`` while leaving the bucketing on
        ``_hash_bucket``'s default — two independent spellings of the same
        number, so raising ``EMBEDDING_BUCKETS`` would have made its PSI
        incomparable to drift.py's with nothing to signal it.

        Checked at source level rather than by calling ``score()``, which
        needs a database. The weaker check is acknowledged rather than
        dressed up: what it really pins is that no bare integer is left in
        either position.
        """
        import inspect

        source = inspect.getsource(risk)
        bare_literals = re.findall(r"_psi\([^)]*n_buckets=(\d+)", source)
        assert not bare_literals, (
            f"risk.py passes a literal n_buckets={bare_literals} to _psi. Use "
            "EMBEDDING_BUCKETS so it cannot drift from the value _hash_bucket "
            "is bucketing into."
        )
        assert re.search(
            r"_psi\([^)]*n_buckets=EMBEDDING_BUCKETS", source
        ), "risk.py's _psi call must state n_buckets=EMBEDDING_BUCKETS"
        assert re.search(
            r"_hash_bucket\(\w+, EMBEDDING_BUCKETS\)", source
        ), (
            "risk.py must pass EMBEDDING_BUCKETS to _hash_bucket explicitly. "
            "Relying on the default is not equivalent: the default is bound "
            "at def time in _common, so it would not follow a changed constant "
            "while the _psi argument would."
        )

    def test_only_stable_hash_constructs_a_blake2b(self) -> None:
        """The anti-duplication guard, and the reason this file exists.

        Scans for real call sites, not the word, so the explanatory prose in
        the delegating docstrings does not count.
        """
        pattern = re.compile(r"hashlib\.blake2b\s*\(")
        offenders = sorted(
            str(path.relative_to(SRC))
            for path in SRC.rglob("*.py")
            if pattern.search(path.read_text(encoding="utf-8"))
        )
        assert offenders == ["util/stable_hash.py"], (
            "blake2b is constructed outside eden/util/stable_hash.py: "
            f"{offenders}. Every such site is a second definition of "
            "'which bucket does this land in', and they drift apart silently "
            "because each one looks correct on its own. Call stable_hash / "
            "stable_bucket / stable_seed instead."
        )


class TestTheDigestWidthAssumption:
    """``trace_keep_position`` divides by ``2**64``.

    That is only a position in ``[0, 1)`` while the digest is exactly 8 bytes.
    A wider digest would push every value toward 0, and since the policy keeps
    when ``position < keep_rate``, sampling would silently keep everything --
    which looks like a working system, not a broken one.
    """

    def test_stable_hash_fits_in_64_bits(self) -> None:
        for i in range(2000):
            assert 0 <= stable_hash(f"trace-{i}") < 2**64

    def test_positions_stay_in_the_unit_interval(self) -> None:
        for i in range(2000):
            assert 0.0 <= trace_keep_position(f"trace-{i}") < 1.0

    def test_positions_are_spread(self) -> None:
        """A constant would satisfy the range check above."""
        deciles = {int(trace_keep_position(f"spread-{i}") * 10) for i in range(500)}
        assert len(deciles) == 10, f"only {len(deciles)} deciles populated"
