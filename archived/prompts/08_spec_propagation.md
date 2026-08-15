# Spec propagation — every commit changes the spec

When you finish an implementation step:

1. Add `§29 v2.7 — production deployment (<date>)` to
   `eden-trace-quality-system-spec.md`.
2. Bump the header to `v2.7 — N tests passing, M migrations live, K
   routes live, sidecar worker wired, per-action kill switches live,
   E enhancements shipped`.
3. Update §11 file structure tree with the new files (migrations,
   routes, schemas, sidecar package, integration tests, e2e tests).
4. Update §6 API surface: confirm each route implemented + test
   count + measured p99.
5. Update §5 with actual migration IDs (matching filenames you
   shipped) and the index-column table.
6. Add a sub-section in §27 (dataset) noting the v2.7 production
   deployment.
7. Add a sub-section in §9 (Risks) closing Risk #6 — the 30-day
   calibration is replaced by per-action kill switches; operators
   review; switch on action-by-action.
8. Add `§29 Enhancement log` table:
   ```
   | Slug | Component | Hypothesis | Metric ↑ | Decision |
   |------|-----------|------------|----------|----------|
   | enh-etec-bootstrap | ETEC composite | bootstrap increases LHP weight | Pearson r +0.07 | SHIPPED |
   | enh-phase3-5th | loop detector | Markov entropy collapse | F1 0.571→0.62 | SHIPPED |
   | enh-phase5-order | quality pipeline | MiniCheck first | F1 +0.04 | SHIPPED |
   ```
9. Add `§29 Handoff note` (last 50 lines of the section) containing:
   - (a) what is live
   - (b) per-action kill switches OFF by default list
   - (c) explicitly deferred (each item cites the spec section that
     documents why)
   - (d) enhancements shipped
   - (e) final `pytest tests/ supplementaries/ -q | tail -3` output
   - (f) `git status` output

## Internal consistency rules

- Every claim in §0, §7, §10, §11 cites a real path that exists in
  the working tree at the end of the iteration.
- Every test count claim (e.g., "≥820 passing") is verifiable via a
  single shell command.
- Every route claim cites an OpenAPI route that's reachable from the
  FastAPI app at startup.
- Every migration claim cites an `alembic current` row.

## When to write a spec section vs. when not to

- Yes: any time you ship code, write a 3-line spec section.
- Yes: any time you change a test count, update §7.
- Yes: any time you add a new route, update §6.
- Yes: any time you remove a feature (don't!), update §29 handoff
  "(c) deferred" with the rationale.
- No: don't write spec sections for in-progress work. Wait until
  it ships.
- No: don't update the spec for a 1-line doc fix. Save the spec
  update for the next major commit.

## When unsure

If you're not sure whether a change warrants a spec update, it does.
The spec is the contract; it must be authoritative.

## Spec propagation is its own commit

Every commit that touches `src/eden/observability/quality_pipeline/`,
`alembic/versions/0{65..71}_*.py`, or `api/routes/trace_quality.py`
MUST also touch `eden-trace-quality-system-spec.md` in the same
commit. Enforce this in CI: a `make check-spec-coverage` target that
asserts the spec's claimed test counts match the actual pytest output.
