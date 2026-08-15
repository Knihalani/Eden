"""Identity, bucketing and seeding must never use the built-in ``hash()``.

Python salts ``hash()`` for ``str`` and ``bytes`` per process (PEP 456), so the
same input gives different values in different workers and after every
restart::

    $ python -c "print(hash('trace-abc') % 1000)"   # 62
    $ python -c "print(hash('trace-abc') % 1000)"   # 441

Eden relied on that value being stable in ten places: k-fold dataset
assignment, canary cohort seeds, cluster ids, embedding vectors, experiment
RNG seeds and detector transition signatures. Every one silently reshuffled on
each deploy — a trace could move to a different fold, a canary could flip
cohort mid-rollout, and two workers computed *different* "deterministic"
embeddings for the same text.

The first class of tests pins the replacement's contract. The last is the
standing guard that stops the built-in coming back.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

from eden.util.stable_hash import stable_bucket, stable_hash, stable_seed

_REPO = Path(__file__).resolve().parents[3]
_SRC = _REPO / "src" / "eden"


class TestDeterminism:
    def test_stable_across_processes(self) -> None:
        """The property the built-in does not have."""
        code = (
            "from eden.util.stable_hash import stable_hash;"
            "print(stable_hash('trace-abc'))"
        )
        outs = {
            subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                cwd=_REPO,
                env={"PYTHONPATH": str(_REPO / "src"), "PATH": "/usr/bin:/bin"},
            ).stdout.strip()
            for _ in range(2)
        }
        assert len(outs) == 1, f"differed across processes: {outs}"
        assert outs != {""}, "subprocess produced no output"

    def test_builtin_hash_really_is_unstable(self) -> None:
        """Guards the premise — if this ever fails, the module is unnecessary."""
        code = "print(hash('trace-abc'))"
        outs = {
            subprocess.run(
                [sys.executable, "-c", code], capture_output=True, text=True
            ).stdout.strip()
            for _ in range(6)
        }
        assert len(outs) > 1, (
            "built-in hash() appears stable — PYTHONHASHSEED may be pinned in "
            "this environment, which would mask the bug in production"
        )

    def test_repeated_calls_agree(self) -> None:
        assert stable_hash("x") == stable_hash("x")
        assert stable_bucket("x", 97) == stable_bucket("x", 97)
        assert stable_seed("x") == stable_seed("x")


class TestBucket:
    @pytest.mark.parametrize("n", [1, 2, 10, 97, 1000, 10000])
    def test_lands_in_range(self, n: int) -> None:
        for i in range(200):
            assert 0 <= stable_bucket(f"key-{i}", n) < n

    def test_zero_buckets_does_not_raise(self) -> None:
        """A bucket count derived from an empty collection must not explode."""
        assert stable_bucket("x", 0) == 0
        assert stable_bucket("x", -5) == 0

    def test_distribution_is_not_degenerate(self) -> None:
        """A hash that puts everything in one bucket would pass the range test."""
        buckets = {stable_bucket(f"trace-{i}", 10) for i in range(500)}
        assert len(buckets) == 10, f"only {len(buckets)}/10 buckets used"


class TestInputHandling:
    def test_tuples_do_not_collide_on_concatenation(self) -> None:
        """``("a","bc")`` and ``("ab","c")`` must differ."""
        assert stable_hash(("a", "bc")) != stable_hash(("ab", "c"))

    def test_str_and_bytes_of_the_same_text_agree(self) -> None:
        assert stable_hash("abc") == stable_hash(b"abc")

    def test_non_negative(self) -> None:
        for i in range(200):
            assert stable_hash(f"k{i}") >= 0

    def test_seed_respects_bit_width(self) -> None:
        for i in range(200):
            assert 0 <= stable_seed(f"k{i}", bits=32) < 2**32
            assert 0 <= stable_seed(f"k{i}", bits=16) < 2**16

    def test_handles_unusual_types_without_raising(self) -> None:
        for value in (None, 42, 3.5, True, ("a", 1), ["x", "y"]):
            assert isinstance(stable_hash(value), int)


class TestNoBuiltinHashForIdentity:
    """The standing guard: ``hash()`` must not be used for stable values.

    ``__hash__`` definitions are exempt — implementing ``__hash__`` for use in
    a dict or set is the built-in's correct purpose. What this forbids is
    *calling* ``hash()`` and depending on the result surviving a restart.
    """

    @staticmethod
    def _offenders() -> list[str]:
        found: list[str] = []
        for path in sorted(_SRC.rglob("*.py")):
            if "db_migrations" in path.parts:
                continue  # migrations run once; seeds there are not identities
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            # Calls to hash() inside a __hash__ body are the legitimate use.
            exempt: set[int] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name == "__hash__":
                    for inner in ast.walk(node):
                        exempt.add(id(inner))
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == "hash"
                    and id(node) not in exempt
                ):
                    rel = path.relative_to(_REPO)
                    found.append(f"{rel}:{node.lineno}")
        return found

    def test_no_builtin_hash_calls_remain(self) -> None:
        offenders = self._offenders()
        assert not offenders, (
            "built-in hash() is salted per process — its result changes on "
            "every restart. Use eden.util.stable_hash "
            "(stable_hash/stable_bucket/stable_seed) for anything persisted, "
            f"bucketed, sharded or seeded. Offenders: {offenders}"
        )
