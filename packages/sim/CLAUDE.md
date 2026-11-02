# @eden/sim

The simulation and the lab: generated worlds and sessions with fact-level ground truth, simulated connectors that
behave like real ones, an oracle judge, the real server under simulated agents over HTTP, and (in `src/lab/`) every
benchmark Eden is judged by. **Not product code**: nothing in engine, server or client imports it. D27: quality and
performance claims cite this package alongside `bun run eval`.

## Files (src/)

| File | Owns |
|---|---|
| `world.ts`, `names.ts`, `text.ts`, `rng.ts` | `buildWorld({seed})`: a user's people, organisations and ~1,500 items over mail, calendar, docs, CRM and chat, deterministic per seed; realistic item text |
| `sessions.ts`, `updates.ts` | Sessions with ground-truth labels per turn; items changed at the source after caching |
| `sources.ts` | `SimSource` and profile sets (`IDEAL`, `REALISTIC`, `REALISTIC_ENTITIES`, `ZOO_*`): AND vs relevance search, snippets, latency, errors, 429s, outages (assumed figures, labelled so) |
| `quality.ts`, `quality-cli.ts` | `runQuality`: sessions through a real `ContextPartner`, scored (`bun run sim`) |
| `judge.ts` | The oracle judge (perfect or noisy) standing in for the model |
| `server.ts`, `load.ts`, `perf-cli.ts` | The real server in its own process under simulated agents through the client SDK (`bun run sim:perf`) |
| `drafts.ts`, `narrow.ts` | Typing lead-ins (anticipation) and narrowed ask questions: simulation assumptions |
| `lab/` | Benchmarks and A/B harnesses: see [src/lab/CLAUDE.md](src/lab/CLAUDE.md) and [docs/LAB.md](../../docs/LAB.md) |

Outside `src/`: `lab/` holds the connector-lab Dockerfiles and `servers.json` (pinned MCP servers), replay caches
(`lab/cards/*.jsonl`), the Hermes plugin and worker (`lab/hermes/`), the Haiku campaign's scripts and summaries
(`lab/haiku/`), and the Python scorers (`lab/scripts/*.py`).

## Rules that apply here

- **Simulated data only.** Worlds are generated; never load real user data, and never commit a run's raw outputs
  except the small replay caches and summaries already kept here (results go to `.local/`, which git ignores).
- **Lab-only switches stay here (D91, D97):** `allowLogging`, free models, the Anthropic provider and the spend
  ledger are wired in `src/lab/free.ts` and `spend.ts`; no product package may name them.
- **Determinism.** Same seed, same world, same tasks. At `--time 0` sources answer instantly and runs are
  reproducible; `--time 1` adds the profiles' assumed latency (a latency study, not a quality one).
- The sim is a test bed for the engine's rules (D7, D10, D11, D9 all still apply to the real `ContextPartner` it
  drives); a sim source that wrote anywhere would be a bug.

## Test

```bash
bun run test:pkg sim             # 19 files, ~4 s wall in parallel; sim.test.ts (~3.5 s alone) leads
bun run sim --users 2 --sessions 5         # a small quality run (JSON), no model, ~1 s
```

## Where next

`docs/research/simulation.md` (the design and its numbers), `docs/research/connector-lab.md`, `docs/LAB.md`,
`bench/README.md` (the benchmark ledger).
