# Eden docs

Eden is passive memory for coding agents. What it does and how to install it: the [root README](../README.md).

## Use it

| Doc | What it covers |
|---|---|
| [README.md](../README.md) | What Eden remembers, how it delivers, guarantees, install, everyday commands |
| [plugins/eden-memory/README.md](../plugins/eden-memory/README.md) | The Claude Code plugin: every hook, what each one stores or delivers, flags and kill switches |
| [packages/cli/README.md](../packages/cli/README.md) | The CLI: every memory command, environment variable, delivery flag and file |

## Build it: the memory program

[memory-ship/](memory-ship/README.md) is the plan, the spec and the record. [CLAUDE.md](../CLAUDE.md) says how to run a slice.

| Doc | Role |
|---|---|
| [memory-ship/PROGRESS.md](memory-ship/PROGRESS.md) | What is done, what is next, and each slice's follow-ups |
| [memory-ship/ROADMAP.md](memory-ship/ROADMAP.md) | The build order: phases, slices, sizes and gates |
| [memory-ship/DECISIONS.md](memory-ship/DECISIONS.md) | Every design decision. **It wins every conflict** |
| [memory-ship/A4-DELIVERY-CONTRACT.md](memory-ship/A4-DELIVERY-CONTRACT.md), [A7-CUES.md](memory-ship/A7-CUES.md), [A6-TRUST-AND-SAFETY.md](memory-ship/A6-TRUST-AND-SAFETY.md) | The normative spec |
| [memory-ship/A5-EVALUATION.md](memory-ship/A5-EVALUATION.md) | The metrics and test arms that gate each slice |
| [memory-ship/EXECUTION.md](memory-ship/EXECUTION.md) | How to build, verify, merge and roll out |
| [memory-ship/reports/](memory-ship/reports/) | One report per merged slice, with its measured numbers |
| [memory-ship/research/](memory-ship/research/) | The evidence (R0–R9) behind the decisions |

Benchmarks for memory live in `benchmarks/`: [memory-long-horizon/](../benchmarks/memory-long-horizon/README.md) is the harness and the arms that gate each slice; `wrap-cache/` is the cached-prefix gate for wrap's injection (D29); `memory-cues/`, `memory-scope/`, `memory-scale/`, `memory-holdout/`, `memory-ambitious/`, `memory-bakeoff/`, `memoryagentbench/`, `lme-v2/` and `terminal-bench/` hold earlier and supporting measurements.

## History

The M1–M50 memory waves (September 2026) came before the memory program. Their documents are superseded and each says so: [MEMORY-PLAN.md](MEMORY-PLAN.md), [MEMORY-WAVES.md](MEMORY-WAVES.md), [MEMORY-WAVE-STATUS.md](MEMORY-WAVE-STATUS.md), [MEMORY-WAVE-PROMPT.md](MEMORY-WAVE-PROMPT.md), [MEMORY-COMPLETE.md](MEMORY-COMPLETE.md), [MEMORY-COMPETITORS.md](MEMORY-COMPETITORS.md), [MEMORY-SOTA-BUILD-REPORT.md](MEMORY-SOTA-BUILD-REPORT.md). The memory program's own earlier drafts are listed in [memory-ship/README.md](memory-ship/README.md).

## Retired product directions

Before memory, Eden was a tool-path compiler: it recorded the tool stretches an agent repeated, compiled them into one inspectable program, and served it from the wrap proxy after a human Approve. Its documents are in [archived/compile-era/](../archived/compile-era/README.md), with the compile-era root README as [compile-guide.md](../archived/compile-era/docs/compile-guide.md).

A few compile-era documents stay in this folder because the website (`apps/web`: `/proof`, `/isolation`) and tests refer to them by path. Each carries a note at the top saying so: [ROADMAP.md](ROADMAP.md) (the compile-era company roadmap), [whitepaper.md](whitepaper.md), [cases.md](cases.md), [isolation.md](isolation.md), [evidence-pack.md](evidence-pack.md), [zdr.md](zdr.md), [logging.md](logging.md), [owasp-mcp.md](owasp-mcp.md). [marketplace-draft.md](marketplace-draft.md) is a renderer's output and carries no note. They move to the archive when the website is rewritten for memory.

The direction before the compiler, an observability platform, is the rest of [archived/](../archived/README.md).
