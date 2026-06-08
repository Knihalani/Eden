"""Shared utilities for the Insights Engine.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import TypeVar

T = TypeVar("T")


def sequence_similarity(seq_a: list[str], seq_b: list[str]) -> float:
    """Compute longest common subsequence (LCS) similarity ratio.

    Returns LCS length divided by max(len(seq_a), len(seq_b)).
    O(m×n) time, O(n) space.
    """
    if not seq_a or not seq_b:
        return 0.0
    m, n = len(seq_a), len(seq_b)
    prev = [0] * (n + 1)
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if seq_a[i - 1] == seq_b[j - 1]:
                curr[j] = prev[j - 1] + 1
            else:
                curr[j] = max(prev[j], curr[j - 1])
        prev, curr = curr, prev
    lcs_len = prev[n]
    return lcs_len / max(m, n)


class BoundedSet:
    """A set with a maximum capacity that evicts oldest entries (FIFO)."""

    def __init__(self, max_size: int = 10000):
        self._max_size = max_size
        self._data: OrderedDict[str, None] = OrderedDict()

    def add(self, item: str) -> None:
        if item in self._data:
            self._data.move_to_end(item)
            return
        self._data[item] = None
        if len(self._data) > self._max_size:
            self._data.popitem(last=False)

    def discard(self, item: str) -> None:
        self._data.pop(item, None)

    def __contains__(self, item: str) -> bool:
        return item in self._data

    def keys(self) -> set[str]:
        """Return a snapshot of all keys in the set."""
        return set(self._data.keys())

    def __sub__(self, other: set[str]) -> set[str]:
        return self.keys() - other

    def __len__(self) -> int:
        return len(self._data)
