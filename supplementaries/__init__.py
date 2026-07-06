"""Deterministic trace evaluation system — the 11-phase supplementaries.

This package is Eden's self-contained, deterministic trace quality
pipeline. Each phase is a small, focused module with an interface
stable enough that ``eden.guardrails`` and ``eden.observability`` can
call it directly in production, while the ``supplementaries/``
directory itself remains an independently runnable test bed.

Phase map
---------
    Phase 1 — Telemetry
        Source of truth lives in ``eden.observability.telemetry_collector``.
        Every downstream phase consumes :class:`TelemetryEvent` objects.

    Phase 2 — Efficiency (``phase_2_efficiency``)
        TAS (Trace Acceptability Score) — the headline 0–100 metric,
        composed from SRR (Step Redundancy Rate), LDI (Loop Detection
        Index), TCA (Tool Call Accuracy), CCE (Context Carry-over
        Efficiency), RDA (Reasoning Depth Appropriateness), ISR
        (Information Sufficiency Rate), OBS (Observation Token Share),
        CCR (Caveman Compression Ratio), LHP (Local Hallucination
        Proxy) and VHP (Verification Presence).

    Phase 3 — Loop Detection (``phase_3_loops``)
        4-detector ensemble (hash ring, Jaccard shingles, semantic
        cosine, Page–Hinkley CUSUM) with a "2 of 4 in 5 steps"
        trip rule. Loads real ``sentence-transformers/all-MiniLM-L6-v2``
        for the semantic path.

    Phase 4 — Guardrails (``phase_4_guardrails``)
        :class:`TrajectoryGuardrail` orchestrator: 8 hot-path checks +
        4 async advisory per step, with action precedence
        ``BLOCK > STOP > ESCALATE > TRUNCATE > REPLAN > REWRITE >
        COALESCE > SUMMARIZE > CACHE > SKIP_STEP > WARN > OK``.

    Phase 5 — Quality (``phase_5_quality``)
        Hallucination detection stack: numeric/AST guard (deterministic
        first), HHEM-2.1-Open, MiniCheck-FT5, BGE reranker. The
        pipeline is interface-ready for real model loading.

    Phase 6 — Stat Gate (``phase_6_stat_gate``)
        Welch's t-test + mSPRT (always-valid) + ECE calibration gate.
        Decides whether detectors get to take a hard action vs. stay
        in "warn-only" mode.

    Phase 7 — Detection (``phase_7_detection``)
        Closed-loop action collector + detector fan-out that funnels
        Phase 3 / Phase 5 / Phase 6 / Phase 9 signals into actionable
        outcomes.

    Phase 8 — Cost (``phase_8_cost``)
        Multi-tier cache (in-memory + Redis + response-fingerprint)
        for LLM cost reduction. Reference numbers from the LLMLingua
        family and τ²-bench (arXiv:2506.07982).

    Phase 9 — Reasoning (``phase_9_reasoning``)
        Composite scorer that surfaces premature conclusion, sanity
        checks, self-correction and verification markers.

    Phase 10 — Memory / A2A (``phase_10_memory``)
        Agent-to-agent message parser, swarm topology detector, and
        agent-depth runaway detector (multi-agent coordination).

    Phase 11 — Benchmark (``phase_11_benchmark``)
        8-category benchmark suite (cost, drift, function-call,
        policy state-diff, recovery, trust, web, code) plus an
        aggregate that produces a single score across all of them.

Cross-cutting
-------------
``cross_phase/test_cross_phase_integration.py`` — runs all phases
together against the synthetic 30-trace dataset and asserts the
end-to-end behaviour matches the spec.
``stress_tests/test_stress.py`` — adversarial-clean / adversarial-noisy
trace generators + latency budgets at 50 / 100 / 500 events.

Determinism guarantee
---------------------
Every test in this directory is reproducible across runs: the local
HuggingFace cache is treated as authoritative for the models we ship,
network is only consulted when the cache has no information. See
``supplementaries/conftest.py`` for the cache-first patch and the
upper-bound behaviour.
"""
