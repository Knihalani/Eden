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

Bun/TypeScript monorepo, no build step (packages export `src/*.ts`). Repo `Knihalani/Eden`, work targets `main`.
Packages: `protocol`, `primitives`, `redact`, `sources`, `graph`, `llm`, `engine`, `server`, `client`, `client-python`,
`proxy`, `eval`, `sim`;
examples in `examples/`. Hot-path code uses `@eden/primitives` (one tokenizer, typed-array structures) and follows its
README's measured rules; a change to a primitive re-runs its benchmark and reports before/after numbers.
Eden has no production npm dependency: the secret gate runs its own linear matchers (D1705; re2js is a devDependency,
the gate tests' oracle) and Eden speaks MCP through its own client and server (D1704; the MCP SDK and zod are
devDependencies, for interop tests and the lab). Justify any new one in the PR. `native/` is the measured Rust experiment behind D22 (hot kernels stay TypeScript), not product code: nothing in
`packages/` imports it.

## Where things are

- Each package has a `CLAUDE.md` (files, rules with decision numbers, quick tests, pitfalls):
  `packages/<name>/CLAUDE.md`, and `packages/sim/src/lab/CLAUDE.md` for the lab.
- [docs/LAB.md](docs/LAB.md): suites, presets, harnesses (funnel, Pi, Hermes), replay caches, providers, recipes
  with costs. [docs/research/INDEX.md](docs/research/INDEX.md): every research note, its decisions and status.
  [docs/TESTING.md](docs/TESTING.md): test commands, timings, the slowest files.
- [docs/DECISION-INDEX.md](docs/DECISION-INDEX.md): one line per decision with its status (adopted, rejected,
  superseded, trial, finding, lab); [docs/DEAD-ENDS.md](docs/DEAD-ENDS.md): every killed idea by topic, read it
  before proposing one. Both are generated from DECISIONS.md by `bun run decisions:index` (D812); a test fails while
  they are stale. After a merge or rebase that touches DECISIONS.md, run `bun run decisions:index`; never
  hand-resolve the generated pages.
- Fast loop: `bun run test:changed` (touched packages and their dependents), `bun run test:pkg <name>`,
  `bun run check:fast` (format, types, changed tests). While developing, a test file that already passed on
  identical inputs is skipped (D650, D657); the gate before a merge is `CHECK_COLD=1 bun run check`, which runs
  every file and trusts no cache.
- `bun run funnel`: the no-model screen on train (the shipped default with its cards and intent requests replayed,
  D158; it asks by default, giving the funnel score, and `--no-ask` opts out; `--baseline F` diffs task by task;
  held-out suites need `--blind`).
- `/deep-audit`: full audit → verified findings → fixes on branches with review → re-audit → plain-language report
  (`.claude/skills/deep-audit/`).

## CI is local

GitHub Actions is off (the user does not pay for minutes). Before every merge, on the final tree:

```bash
CHECK_COLD=1 bun run check   # format:check (prettier + 120-col line check), typecheck and test at once, no caches
bun run eval    # no-model metrics; paste the JSON in the PR when engine behaviour changes
```

The no-model eval runs on each scenario's own clock, so its result does not depend on the day it runs (D435). On
main it reads precision 0.84, recall 0.62, falseFireRate 0. Its `acting` block (D810: requests that act, where the
default's push of candidates runs) reads packets on 8 of 28 neutral requests (0.43 items each), facts handed 10 of
11, a look-alike handed on 3 of 10 owed requests. Treat a difference from any of those numbers as a change in behaviour.

The standard agent for live agent tests (`agent-ab.ts`, any "Eden against tools" comparison) is the **Pi harness**
(pi-mono's agent loop, `earendil-works/pi`, formerly `badlogic/pi-mono`): its minimal loop and tools, with Eden added
as a tool or as injected context. Until the lab runs on Pi, label any agent result from the older in-house loop as such.

`bun run format` fixes formatting except long comments. Engine changes that touch scoring, thresholds or
delivery also run `bun run eval --live --usd-cap 0.05` (needs `OPENROUTER_API_KEY`; costs fractions of a cent) and
report both runs. `--live` is the shipped wiring (live reader, no judge) and refuses to start without a hard dollar
cap (D128); `--live --judge --usd-cap 0.05` re-runs the pre-D128 shape (judge on, reader stub). Where paid calls are
limited to Anthropic, `bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17`
runs the same shipped wiring with the reader on `claude-haiku-5-5` (`HAIKU_API_KEY`, about $0.001): a lab transport
(D97), not the shipped OpenRouter route, so label its numbers so.

## Engineering rules

- **One product (D112, D814).** `DEFAULT_CONFIG` is the best measured configuration, and it is what ships: the
  servers run it, with its model roles on when a model key is set and its no-model path when not. New behaviour
  enters behind a trial switch (a row in the trials table in docs/DECISIONS.md, below the decisions), and the branch
  or session that opened it decides it as soon as its evidence is in: promoted into the default (measured better or
  neutral at no extra paid cost) or deleted with its code and tests. No end dates weeks out, no "owner's call later";
  where a cost trade-off remains, the session recommends and the parent decides that day. Pre-register the rule in
  one line of a commit before a paid run. Lab presets are only `default` and `default minus <part>` (`PARTS` in
  `@eden/engine`).
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
- **Secrets.** Never commit `.env` or real user data. Never print `OPENROUTER_API_KEY`. Lab scripts (packages/sim/)
  refuse to start while it is set unless `EDEN_ALLOW_OPENROUTER=1` (D818, `scripts/lab-guard.ts`): paid lab calls go
  to the Anthropic API. Tests run with a temp
  `HOME`/`EDEN_HOME` and with `EDEN_*`/`OPENROUTER_*` cleared (`scripts/test-preload.ts`).
- **Readable code.** 120-column limit (only literals may exceed it). Comments explain why, at the density of the
  surrounding code. Do not join lines to shrink line counts.
- **Honest numbers.** Every number in a PR, doc or report comes from a command run in that session; label anything
  unverified.

## Workflow

1. Branch from up-to-date `main` (`git fetch origin main`), one change per PR.
2. Tests first for behaviour changes; eval scenarios for engine behaviour.
3. `CHECK_COLD=1 bun run check` green; eval JSON in the PR if the engine changed.
4. Update `docs/` in the same PR when behaviour, a decision or the roadmap changes.
5. Run the `reviewer` subagent (`.claude/agents/reviewer.md`) once on the code before merging engine, server or
   privacy changes; fix its correctness findings and merge (D814). No re-review for docs-only fixes or low findings.
6. Agents may open and merge their own PRs into `main` once the above holds. Never force-push `main`.
