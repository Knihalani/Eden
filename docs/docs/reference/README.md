# Legacy Design Documents

This directory contains **historical design documents** that informed
earlier directions of the Eden platform. The content of each has since
been **materialized into code** by the implementation work tracked in
the migration plan, and the live, authoritative version of the system
now lives in the source tree — **not** in these markdown files.

## Why these are archived here

These docs were written when the Eden Agent CLI and its Aider fork
strategy were still in the "design" phase. They were originally placed
at the repository root alongside the other architecture documents
(`eden-master-architecture-index.md`, `eden-observability-and-knowledge-architecture.md`,
etc.) as living design specs.

After the **observability + improvement platform** pivot (see
`/Users/kaiavnihalani/.claude/plans/composed-painting-pretzel.md`), the
direction in these documents was implemented by units C1 and C2 of the
migration batch. The CLI now lives in the `cli/` directory at the repo
root (entry point: `eden integrate-eden`), so the original prose design
docs are no longer the source of truth.

## Contents

| File | What it described | Where the implementation lives now |
|---|---|---|
| `aider-fork-strategy.md` | The strategy for forking Aider to build the Eden coding agent — branding, philosophy, technical hooks, KB integration. | `cli/` directory (entry: `cli/eden/__main__.py`). The `EdenCoder` subclass lives at `cli/eden/coders/eden_coder.py`. |
| `eden-agent-cli-roadmap.md` | The 12-week phased delivery plan for the Eden Agent CLI. | Tracked as a unit in the migration plan; the live roadmap is `/observability/roadmap` at the repo root. |
| `eden-agent-cli-spec.md` | The full functional specification (slash commands, context providers, autonomy modes, safety guardrails). | The slash-command implementations are in `cli/eden/commands/` (`kb.py`, `traces.py`, `improve.py`, `pr.py`, `integrate.py`, `bench.py`, `pipeline.py`). Autonomy and safety live in `cli/eden/autonomy.py`. |

## If you're looking for…

- **The current CLI documentation** — see `cli/README.md` in the `cli/` directory.
- **The current platform roadmap** — see `/observability/roadmap` at the repo root.
- **The current architecture** — see `docs/ARCHITECTURE.md` and `eden-master-architecture-index.md`.
- **The migration plan that produced the current `cli/` directory** — see `/Users/kaiavnihalani/.claude/plans/composed-painting-pretzel.md`.

## Important note

These documents are **frozen as of June 2026**. Do not edit them in
place to reflect the new state of the codebase — instead, update the
authoritative source (`cli/`, `docs/ARCHITECTURE.md`, the migration
plan, etc.) and let this archive stand as a historical record of how
the design was originally articulated.
