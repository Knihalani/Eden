# Contributing (private)

This package is **not** open-source. PRs stay in the private Eden repo.

Public artifact: graph dumps (`docs/data.md`), not this tree.

## Rules

- Honor RFC 9309 robots. Do not add a robots bypass, Playwright, or paywall fetch.
- Wikipedia and other robots-ok hosts are **in**. Listed paywalls stay out.
- Do not commit `*.sqlite`, `*.kpk`, or `.env`.
- Retrieval injects one grounded card or unknown. Never dump the graph onto the wire.
- Know must not import wrap.

`bun test` from this directory (or `bun test packages/know` in the monorepo).
