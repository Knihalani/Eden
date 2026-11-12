# @eden/sim

The simulation and the lab: generated worlds and sessions with fact-level ground truth, simulated connectors that
behave like real ones, an oracle judge, the real server under simulated agents over HTTP, and (in `src/lab/`) every
benchmark Eden is judged by. **Not product code**: nothing in engine, server or client imports it. D27: quality and
performance claims cite this package alongside `bun run eval`.

## Files (src/)

| File | Owns |
|---|---|
| `world.ts`, `names.ts`, `text.ts`, `rng.ts` | `buildWorld({seed})`: a user's people, organisations and ~1,500 items over mail, calendar, docs, CRM and chat, deterministic per seed; realistic item text |
| `rare-sources.ts` | Eight rarely used connectors (notes, whatsapp, bank, health, school, trips, residents, tasks) with filler, each on a world source's profile (`profileFor`); added by suites.ts's `prepareWorld` (D873) |
| `realism.ts` | `--realism heavy` (D1103): `addRealism`, a heavy real user's twenty connectors and 600 items a world that never apply (rule-like, forwarded, five languages), added by `prepareWorld` when `setRealism` is on |
| `sessions.ts`, `updates.ts` | Sessions with ground-truth labels per turn; items changed at the source after caching |
| `sources.ts` | `SimSource` and profile sets (`IDEAL`, `REALISTIC`, `REALISTIC_ENTITIES`, `ZOO_*`): AND vs relevance search, snippets, latency, errors, 429s, outages (assumed figures, labelled so) |
| `quality.ts`, `quality-cli.ts` | `runQuality`: sessions through a real `ContextPartner`, scored (`bun run sim`) |
| `judge.ts` | The oracle judge (perfect or noisy) standing in for the model |
| `server.ts`, `load.ts`, `perf-cli.ts` | The real server in its own process under simulated agents through the client SDK (`bun run sim:perf`) |
| `drafts.ts`, `narrow.ts` | Typing lead-ins and narrowed ask questions: simulation assumptions |
| `demo.ts` | `bun run demo` (D292): one simulated user through the shipped server and client with no key, what Eden added and why per request; optional agent (`OPENAI_API_KEY`), `--trace` for `bun run digest` |
| `lab/` | Benchmarks and A/B harnesses: see [src/lab/CLAUDE.md](src/lab/CLAUDE.md) and [docs/LAB.md](../../docs/LAB.md) |
| `pilot/` | The real-data pilot kit (F3, D489; [docs/PILOT.md](../../docs/PILOT.md)): `bun run pilot`: one consenting account's redacted import (`import.ts`, through the server's connector presets), the owner's own requests, the Pi harness on them (`world.ts`, `pi-ab --world-file`), blind marks (`annotate.ts`) and a paired report (`report.ts`); files only in `EDEN_PILOT_DIR`, outside any git work tree (`store.ts`). Built, not run on real data; its tests use sim data |

Outside `src/`: `lab/` holds the connector-lab Dockerfiles and `servers.json` (pinned MCP servers), replay caches
(`lab/cards/*.jsonl`), the Hermes plugin and worker (`lab/hermes/`), the Haiku campaign's scripts and summaries
(`lab/haiku/`), the Python scorers (`lab/scripts/*.py`), and `lab/before-after/` (rebuilds the pre-campaign
BEFORE tree and makes the tables of docs/research/final-before-after.md). `modal/` holds the Modal lab apps (D408:
fan-out, card distillation, embedding screen; Python, `modal==1.6.3`, README there), lab tooling like the rest.

## Rules that apply here

- **Simulated data only.** Worlds are generated; never load real user data, and never commit a run's raw outputs
  except the small replay caches and summaries already kept here (results go to `.local/`, which git ignores).
  **The one exception is `pilot/` (D489):** the account's owner, on their own machine, may run it on their own data,
  which stays in `EDEN_PILOT_DIR` (refused inside a git work tree). No session, test or benchmark uses real data:
  the pilot's own tests run on generated worlds.
- **Lab-only switches stay here (D91, D97):** `allowLogging`, free models, the Anthropic provider and the spend
  ledger are wired in `src/lab/free.ts` and `spend.ts`; no product package may name them.
- **Determinism.** Same seed, same world, same tasks. At `--time 0` sources answer instantly and runs are
  reproducible; `--time 1` adds the profiles' assumed latency (a latency study, not a quality one).
- The sim is a test bed for the engine's rules (D7, D10, D11, D9 all still apply to the real `ContextPartner` it
  drives); a sim source that wrote anywhere would be a bug.

## Test

```bash
bun run test:pkg sim             # 58 files, 22.9-23.6 s cold (4 cores, 2026-11-11); cards-disk and sim.test lead
bun run sim --users 2 --sessions 5         # a small quality run (JSON), no model, ~1 s
```

## Where next

`docs/research/simulation.md` (the design and its numbers), `docs/research/connector-lab.md`, `docs/LAB.md`,
`bench/README.md` (the benchmark ledger).
