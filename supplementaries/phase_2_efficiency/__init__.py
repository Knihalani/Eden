"""Phase 2 — Efficiency: TAS (Trace Acceptability Score) composite.

Computes the headline 0–100 metric by weighting 10 sub-metrics
(SRR, LDI, TCA, CCE, RDA, ISR, OBS, CCR, LHP, VHP) into a single
``TASResult`` per trace. ``ARCHETYPE_TVS`` lets callers vary the
importance of a trace by outcome + context (e.g. a hallucinated
critical-path step counts for more than a benign retry).
"""
