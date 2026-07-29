"""A tiny in-process metric registry that ``/metrics`` can actually read.

Two modules — the checkpoint ingest hook and the quality-pipeline worker —
built their counters on ``prometheus_client``, falling back to no-op shims when
the library was absent. Both problems were silent:

* ``prometheus_client`` is not a declared dependency, so on any deployment
  without it the metrics were no-ops that recorded nothing;
* and where it *was* installed, the counters registered into the library's
  default registry, which the hand-rolled ``/metrics`` endpoint never reads.
  The numbers were collected correctly and then thrown away.

Either way the two modules were dark. This registry replaces both branches with
one implementation that always records and is always exposed. The public shape
deliberately mirrors ``prometheus_client`` (``.labels(...).inc()``,
``.observe()``, ``.set()``) so the call sites did not have to change.

Histograms are rendered as summaries (``_sum``/``_count``): every consumer of
these series wants a mean or a rate, none of them run ``histogram_quantile``,
and bucket boundaries chosen without a use case are just cardinality. The
per-route request histogram, which genuinely needs quantiles, keeps its own
bucketed implementation in ``api/middleware/latency.py``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator, Mapping

logger = logging.getLogger(__name__)

#: Per-family ceiling on distinct label combinations. These families have
#: closed label vocabularies (a fixed set of statuses and step names), so the
#: cap should never bind; it is here so that a label value accidentally wired
#: to user input degrades into one overflow series instead of unbounded
#: memory growth. ``api/middleware/latency.py`` documents what that costs when
#: it is missing.
_MAX_SERIES = 128

_OVERFLOW = "__overflow__"

_lock = threading.Lock()
_registry: list[_Family] = []


class _Family:
    """Base: a named metric with a fixed label-name tuple."""

    metric_type = "untyped"

    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...] = ()) -> None:
        self.name = name
        self.help_text = help_text
        self.labelnames = labelnames
        self._values: dict[tuple[str, ...], float] = {}
        self._counts: dict[tuple[str, ...], float] = {}
        with _lock:
            _registry.append(self)

    def _key(self, values: tuple[str, ...]) -> tuple[str, ...]:
        """Map a label tuple to its slot, folding overflow into one series."""
        if values in self._values or len(self._values) < _MAX_SERIES:
            return values
        return (_OVERFLOW,) * len(self.labelnames)

    def _labels_tuple(self, kw: Mapping[str, str]) -> tuple[str, ...]:
        try:
            return tuple(str(kw[n]) for n in self.labelnames)
        except KeyError:
            # A missing label would otherwise raise on the hot path. Record it
            # under a placeholder and complain, rather than break the caller.
            logger.warning(
                "simple_metrics: %s expects labels %s, got %s",
                self.name,
                self.labelnames,
                sorted(kw),
            )
            return tuple(str(kw.get(n, "")) for n in self.labelnames)

    def reset(self) -> None:
        with _lock:
            self._values.clear()
            self._counts.clear()

    def _snapshot(self) -> tuple[list[tuple[tuple[str, ...], float]], dict[tuple[str, ...], float]]:
        """Copy the counters under the lock.

        Rendering must not iterate the live dicts: a concurrent increment
        during a scrape would raise ``dictionary changed size during
        iteration`` and take out the whole ``/metrics`` response.
        """
        with _lock:
            return sorted(self._values.items()), dict(self._counts)

    def samples(self) -> list[tuple[str, dict[str, str], float]]:
        """Return ``(suffix, labels, value)`` triples for this family."""
        raise NotImplementedError


class _Bound:
    """A family pinned to one label combination."""

    __slots__ = ("_family", "_key")

    def __init__(self, family: _Family, key: tuple[str, ...]) -> None:
        self._family = family
        self._key = key

    def inc(self, n: float = 1.0) -> None:
        with _lock:
            k = self._family._key(self._key)
            self._family._values[k] = self._family._values.get(k, 0.0) + float(n)

    def observe(self, value: float) -> None:
        with _lock:
            k = self._family._key(self._key)
            self._family._values[k] = self._family._values.get(k, 0.0) + float(value)
            self._family._counts[k] = self._family._counts.get(k, 0.0) + 1.0

    def set(self, value: float) -> None:
        with _lock:
            k = self._family._key(self._key)
            self._family._values[k] = float(value)


class Counter(_Family):
    """A monotonically increasing count."""

    metric_type = "counter"

    def labels(self, **kw: str) -> _Bound:
        return _Bound(self, self._labels_tuple(kw))

    def inc(self, n: float = 1.0) -> None:
        _Bound(self, ()).inc(n)

    def samples(self) -> list[tuple[str, dict[str, str], float]]:
        return [
            ("", dict(zip(self.labelnames, k, strict=False)), v)
            for k, v in sorted(self._values.items())
        ]


class Summary(_Family):
    """Observations reduced to a running ``_sum`` and ``_count``."""

    metric_type = "summary"

    def labels(self, **kw: str) -> _Bound:
        return _Bound(self, self._labels_tuple(kw))

    def observe(self, value: float) -> None:
        _Bound(self, ()).observe(value)

    def samples(self) -> list[tuple[str, dict[str, str], float]]:
        out: list[tuple[str, dict[str, str], float]] = []
        for k, total in sorted(self._values.items()):
            labels = dict(zip(self.labelnames, k, strict=False))
            out.append(("_sum", labels, total))
            out.append(("_count", labels, self._counts.get(k, 0.0)))
        return out


class Gauge(_Family):
    """A value that goes up and down."""

    metric_type = "gauge"

    def labels(self, **kw: str) -> _Bound:
        return _Bound(self, self._labels_tuple(kw))

    def set(self, value: float) -> None:
        _Bound(self, ()).set(value)

    def samples(self) -> list[tuple[str, dict[str, str], float]]:
        return [
            ("", dict(zip(self.labelnames, k, strict=False)), v)
            for k, v in sorted(self._values.items())
        ]


def iter_families() -> Iterator[_Family]:
    """Yield every registered family, in registration order."""
    with _lock:
        return iter(list(_registry))


def reset_for_tests() -> None:
    """Zero every registered family without unregistering it."""
    for fam in list(iter_families()):
        fam.reset()


__all__ = [
    "Counter",
    "Gauge",
    "Summary",
    "iter_families",
    "reset_for_tests",
]
