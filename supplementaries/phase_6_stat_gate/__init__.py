"""Phase 6 — Statistical gate.

Combines Welch's t-test, an always-valid mSPRT sequential test
(Howard et al. 2021), and an Expected Calibration Error gate
to decide whether the closed-loop detectors get to take hard
actions or stay in warn-only mode.

Hot-path overhead is microseconds per call. The mSPRT
implementation is overflow-safe (exponent clamped at 700).
"""
