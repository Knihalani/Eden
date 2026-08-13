"""Canonical severity / channel vocabulary for Eden's alert-routing systems.

Re-exports :class:`AlertSeverity` and :class:`AlertChannel` from their
canonical definition in :mod:`eden.realtime.alert_stream`.

This module was previously located at ``eden.alerting.types``; that package
has been removed (OOM plan 8.1 / A6).  Any import that used
``from eden.alerting.types import …`` should be updated to
``from eden.alerts.types import …``.
"""

from __future__ import annotations

from eden.realtime.alert_stream import AlertChannel, AlertSeverity

__all__ = ["AlertChannel", "AlertSeverity"]
