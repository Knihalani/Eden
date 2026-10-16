# Example traces

> **Compile era: retired.** These traces feed Eden's earlier tool-path compiler. The commands still run and the tests still use these files, but Eden is now passive memory for coding agents ([README](../../README.md)); the compile-era documents are in [archived/compile-era/](../../archived/compile-era/README.md).

Shipped dirs a person can open. Honest paths: compile, unique work (0 programs), named refusal. Compile does not mint a wrap candidate. Import may mint one; that is a verdict, not a ship.

## Inspect (offline)

`eden compile` prints a letter. It does not Approve. It does not hit the network.

```bash
eden compile --traces examples/compile-traces/repeating
eden compile --traces examples/compile-traces/unique
eden compile --traces examples/compile-traces/foreach
eden compile --traces examples/compile-traces/refuse
eden compile --traces examples/compile-traces/branch
eden compile --traces examples/compile-traces/poll
eden compile --traces examples/compile-traces/cursor
eden compile --traces examples/compile-traces/offset
```

From a clone, that is `bun packages/cli/src/cli.ts compile --traces …` (or `alias eden='bun packages/cli/src/cli.ts'`).

| Dir | What you should see |
|---|---|
| `repeating` | One program (`lookupTicket → writeRecord → notify`). |
| `unique` | **0 programs** — unique work, not a compile win. |
| `foreach` | A program whose letter names **foreach** (`listCart → foreach reserveSku → checkoutCart`). |
| `refuse` | Named refusal **`underdetermined_write`**. |
| `branch` | A program whose letter names **branch** (3-arm on sev). |
| `poll` | A program whose letter names **poll until ready**. |
| `cursor` | A program whose letter names **cursor pages**. |
| `offset` | A program whose letter names **offset pages**. |

Unique work and refusals: `eden explain`.

## Wrap verdict (does not ship)

Wrap stores traces and compiles on intake. Human Approve is the On switch. These toy traces will not PASS until shadow certifies measured token or time savings — do not fake duration or tokens. Default wrap may show `pending` (uncovered tools). None of those ship.

```bash
eden wrap
eden import --traces examples/compile-traces/repeating
eden approve                         # FAIL / INCONCLUSIVE / pending until shadow certifies; cannot ship
```

`eden import --traces` POSTs the same StretchTrace JSON as compile. It does not Approve. When wrap minted a candidate, Next is `eden approve` to read the verdict — not play.

A custom agent records via `POST /v1/ingest` (see `examples/agent/`). Same wrap, same compile-on-intake.

## Play a compiled tool in one sitting

`bun run demo` is TicketShip: compile, Approve in the demo, play **T-100**. Quote that demo. Do not fake metrics. Then `eden play` against that wrap if it is still up.

```bash
bun run demo
```

## Your own agent

Record through wrap, then `eden explain`, `eden approve <id> --yes`, `eden play --input`.
