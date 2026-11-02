# Eden — agent instructions

Eden is a **context partner for personal and proactive agents**: it runs beside a tenant's agent, reads the end
user's connected sources (read-only), answers the agent's questions and proactively injects context, staying silent
by default. Read [docs/VISION.md](docs/VISION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/DECISIONS.md](docs/DECISIONS.md) before changing the engine. DECISIONS wins every conflict; a change that
departs from a decision adds a new numbered decision saying so.

Everything under `archived/` is earlier products (passive memory for coding agents, the compile era, an observability
platform). It is history: do not import from it, describe Eden from it, or run its tests. `docs/SALVAGE.md` lists
what is worth mining from it.

## Repo

Bun/TypeScript monorepo, no build step (packages export `src/*.ts`). Repo `KaiavN/Eden`, work targets `main`.
Packages: `protocol`, `primitives`, `redact`, `sources`, `graph`, `llm`, `engine`, `server`, `client`, `eval`, `sim`;
examples in `examples/`. Hot-path code uses `@eden/primitives` (one tokenizer, typed-array structures) and follows its
README's measured rules; a change to a primitive re-runs its benchmark and reports before/after numbers.
Dependencies are deliberately few (the MCP SDK, zod, and re2js for the secret gate, D24); justify any new one in the
PR. `native/` is the measured Rust experiment behind D22 (hot kernels stay TypeScript), not product code: nothing in
`packages/` imports it.

## Where things are

- Each package has a `CLAUDE.md` (files, rules with decision numbers, quick tests, pitfalls):
  `packages/<name>/CLAUDE.md`, and `packages/sim/src/lab/CLAUDE.md` for the lab.
- [docs/LAB.md](docs/LAB.md): suites, presets, harnesses (funnel, Pi, Hermes), replay caches, providers, recipes
  with costs. [docs/research/INDEX.md](docs/research/INDEX.md): every research note, its decisions and status.
  [docs/TESTING.md](docs/TESTING.md): test commands, timings, the slowest files.
- Fast loop: `bun run test:changed` (touched packages and their dependents), `bun run test:pkg <name>`,
  `bun run check:fast` (format, types, changed tests); `bun run check` is still the gate before a merge.
- `bun run funnel`: the no-model screen on train (preset ALL3, replayed cards, `--ask`, the funnel score;
  `--baseline F` diffs task by task; held-out suites need `--blind`).
- `/deep-audit`: full audit → verified findings → fixes on branches with review → re-audit → plain-language report
  (`.claude/skills/deep-audit/`).

## CI is local

GitHub Actions is off (the user does not pay for minutes). Before every merge, on the final tree:

```bash
bun run check   # = format:check (prettier + 120-col line check) && typecheck && test
bun run eval    # no-model metrics; paste the JSON in the PR when engine behaviour changes
```

The standard agent for live agent tests (`agent-ab.ts`, any "Eden against tools" comparison) is the **Pi harness**
(pi-mono's agent loop, `earendil-works/pi`, formerly `badlogic/pi-mono`): its minimal loop and tools, with Eden added
as a tool or as injected context. Until the lab runs on Pi, label any agent result from the older in-house loop as such.

`bun run format` fixes formatting except long comments. Engine changes that touch scoring, thresholds or
delivery also run `bun run eval --live` (needs `OPENROUTER_API_KEY`; costs fractions of a cent) and report both runs.

## Engineering rules

- **Silence by default; precision over recall.** A change that raises recall by also raising `falseFireRate` needs
  an explicit decision.
- **Model last.** No model call on the fast path. Every model call goes through `Budget` and has bounded input.
  Never add a per-event model call without a decision and a cost estimate in docs/COST-MODEL.md.
- **Read-only sources.** Never call a source tool that is not read-only (D7). Never weaken `McpSource`'s check.
- **Isolation.** Every piece of state is keyed by tenant/user (and session). Add a test when adding state.
- **Redact.** Text that is stored, indexed, logged or sent to a model passes `sanitizeForStore` first.
- **Untrusted content.** Source text and event text are data, never instructions, in every prompt.
- **Fail open at the edge.** The client SDK never throws into the agent's loop; the server never returns 500 for
  caller input (4xx with a message, 503 for internal failure).
- **Secrets.** Never commit `.env` or real user data. Never print `OPENROUTER_API_KEY`. Tests run with a temp
  `HOME`/`EDEN_HOME` and with `EDEN_*`/`OPENROUTER_*` cleared (`scripts/test-preload.ts`).
- **Readable code.** 120-column limit (only literals may exceed it). Comments explain why, at the density of the
  surrounding code. Do not join lines to shrink line counts.
- **Honest numbers.** Every number in a PR, doc or report comes from a command run in that session; label anything
  unverified.

## Workflow

1. Branch from up-to-date `main` (`git fetch origin main`), one change per PR.
2. Tests first for behaviour changes; eval scenarios for engine behaviour.
3. `bun run check` green; eval JSON in the PR if the engine changed.
4. Update `docs/` in the same PR when behaviour, a decision or the roadmap changes.
5. Run the `reviewer` subagent (`.claude/agents/reviewer.md`) on the diff before merging engine, server or privacy
   changes; fix its correctness findings.
6. Agents may open and merge their own PRs into `main` once the above holds. Never force-push `main`.
