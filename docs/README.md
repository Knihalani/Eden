# Docs

| Doc | What it holds |
|---|---|
| [VISION.md](VISION.md) | The thesis, why not a subagent, scope, principles |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flow, the two speeds, the learning loop |
| [DECISIONS.md](DECISIONS.md) | Every design decision, numbered. It wins conflicts |
| [ROADMAP.md](ROADMAP.md) | Milestones M0–M6 |
| [COST-MODEL.md](COST-MODEL.md) | Prices, per-call bounds, measured costs, levers |
| [PRIVACY.md](PRIVACY.md) | Data flow, subprocessors, ZDR, controls, open items |
| [RESEARCH.md](RESEARCH.md) | The Meta PMA paper and open questions |
| [research/primitives.md](research/primitives.md) | What `@eden/primitives` is built from, with every benchmark table |
| [research/fast-primitives.md](research/fast-primitives.md) | Deep research: the fastest primitives for each stage, with parameters and costs ([notes](research/fast-primitives-notes/)) |
| [research/language-choice.md](research/language-choice.md) | Measured: TS on Bun vs Bun built-ins vs Rust (bun:ffi, WASM, napi-rs) for the hot kernels ([native/](../native/)) |
| [research/architecture-alternatives.md](research/architecture-alternatives.md) | Measured: CPU off the event loop (worker pool) and a linear-time regex engine for the secret gate (ReDoS) |
| [SALVAGE.md](SALVAGE.md) | What was kept from the archived memory product, and what is worth mining |
