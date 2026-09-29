# RUN-LOCAL AMBITION OVERRIDE (this run only — do NOT copy into the skill)

User directive: innovations must be >=3x more ambitious than the SKILL.md Ambition bar, with NO cap.

Bar for this run:
- An experiment is a SUBSYSTEM-level change: replace/rebuild an entire retrieval architecture, storage model,
  representation, or language runtime — not a stage, not a lane, not a boost.
- Target upside per experiment: >=15-30% on brain-opt AND clear held-out gains. Anything whose ceiling is <10% is not worth an experiment slot.
- Allowed: new subsystems (dual episodic/semantic memory, world-model compilation, dense/static-embedding channels with
  in-repo ANN index, native core via Bun FFI/WASM in Zig/Rust, offline self-supervised rankers, evolutionary
  pipeline search), new offline deps if fully local, large diffs, multi-file rewrites.
- Gates unchanged: all 5 benches, junk/losses 0, cost_ms 0. Ambition never relaxes the gates.
- Every patch: `MECHANISM — WHY (failure class) — EXPECT (>=15%)`.
- Failures are reported with numbers; a measured bold failure beats an unmeasured safe idea.
