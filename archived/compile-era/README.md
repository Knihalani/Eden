# Compile era (retired product direction)

Eden is a memory product: passive, per-repo memory for coding agents. The current docs start at the [root README](../../README.md) and [docs/README.md](../../docs/README.md).

Before that (August–September 2026), Eden was a tool-path compiler. It recorded the tool stretches an agent repeated, compiled them into one inspectable program, and served that program from the wrap proxy after a human Approve. Two side lines grew from it: Eden Know, a robots-honoring knowledge graph that injected one fact card per turn, and a public proof site built on measured campaign claims. The direction before that, an observability platform, is the rest of `archived/`.

## What is here

The compile-era product documents, moved out of `docs/` and the repo root on 2026-10-16. Their contents are unchanged (`compile-guide.md` gained a title and a note), so paths inside them (`docs/…`) name where each file lived when it was written.

| File | What it was |
|---|---|
| [docs/generalization-plan.md](docs/generalization-plan.md) | The plan to generalize the compiler across agent domains |
| [docs/waste-audit.md](docs/waste-audit.md) | Map of wasted computation in LLM agents, and where the compiler stood |
| [docs/dispatch.md](docs/dispatch.md) | The empty-catalog dispatch design (`tools/dispatch`, `POST /v1/dispatch`) |
| [docs/compile-refusals.md](docs/compile-refusals.md) | One row per compile `Refusal.code` |
| [docs/audit-plan.md](docs/audit-plan.md) | The 2026-08-24 full audit of the compiler, runtime and CLI |
| [docs/reasonblocks-competitive-report.md](docs/reasonblocks-competitive-report.md) | Competitive teardown against the compiled-tools pitch |
| [docs/product-2.md](docs/product-2.md) | Eden Know, the knowledge-graph product |
| [docs/spec.md](docs/spec.md) | The one-page compiled-tools spec that sat at the repo root |
| [docs/compile-guide.md](docs/compile-guide.md) | The root README of the compile era: install, compile, wrap verdicts, Approve, play, the demo |

## What is still in the tree

The code these documents describe was not removed, and its tests still run in CI:

- packages: `compile`, `runtime`, `shadow`, `measure`, `know`, `sdk-js` (`@kaiavn/sdk`), `sdk-py` (`eden-agent`), and the compile and play paths of `wrap` (`ir` is shared: memory's secret gate uses its redactor);
- CLI commands: `compile`, `import`, `explain`, `approve`, `play`, `demo`, `claims`, `savings`, `promote`, `schedule`, `audit`, `archive`, `know` and the others under "compile traces into a tool" in `eden --help`;
- examples: `examples/compile-traces/` and `examples/agent/`;
- benchmarks: `benchmarks/campaign/` and `benchmarks/poc/`.

Some compile-era documents stay in `docs/` because the website (`apps/web`: `/proof`, `/isolation`) and tests refer to them by path: `ROADMAP.md`, `whitepaper.md`, `cases.md`, `isolation.md`, `evidence-pack.md`, `zdr.md` and `marketplace-draft.md`, plus `logging.md` and `owasp-mcp.md`, which those link to. Each carries a note saying so, except `marketplace-draft.md`, which a test requires to equal its renderer's output. They move here when the website is rewritten for memory.
