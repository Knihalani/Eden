"""Phase 7 — Detection fan-out and closed-loop action collector.

``run_all_detectors`` walks Phase 3 (loop ensemble), Phase 5
(quality) and Phase 9 (reasoning) signals and emits per-step
``DetectorVerdict`` records. ``collect_closed_loop_actions``
then folds those into a single concrete action stream that the
TrajectoryGuardrail can consume.

The Phase 6 stat-gate sits between the two: an unwarned detector
cluster cannot flip the final action from ``warn`` to ``block``.
"""
