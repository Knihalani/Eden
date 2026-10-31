# The econ lab base

Status: 2026-10-31. The lab instruments the seven econ research tracks built separately (oneturn, uptake, decide,
firewall, background, judge, research), merged into one version of each tool before any of their engine changes land.
It changes no engine code and no decision. Each track's engine flag arrives in its own change, and its lab pieces that
need that flag arrive with it. The plan is the econ synthesis (integration plan, PR 1).

## Blind suite 9

`hidden-heldout9.ts` (28 templates) is registered in `suites.ts` as `heldout9`. It was copied in unread and has
never been run. The registry test plants it only to check that its ids are unique and carry the suite name. Like
held-out 5–8, it is measurement only: name it on the blind run, never while tuning. `heldout-all` still means the
in-sample held-out suites 1–4, and `all` now includes `heldout9`.

## pi-ab: one grammar for conditions

The tracks had four versions of one idea:
- oneturn: `eden-1t[.iXbY]`;
- uptake: `eden+flag`;
- judge: `eden~name` with `--variant-config`;
- firewall: `--act` with `*-act*`.

`pi-conditions.ts` now has one grammar for all of them:

```
<base>[-act][~variant][+flag ...][@w<ms>]
```

- **base:** `none`, `tools`, `eden`, `both`, `eden-judge` or `both-judge`. Any other base throws. Before this change,
  any name that was not `none` or `tools` ran Eden, so a typo ran under the wrong name.
- **`~variant`:** adds the settings that `--variant-config '{"name":{...}}'` gives that name, on top of `--config`.
- **`+flag`:** turns one engine flag on, as shorthand. It stacks on a variant, as in `eden~ALL2+judgeBehind`.
- **Checks:** a variant setting or flag that is not an engine setting (`DEFAULT_CONFIG`'s keys) throws. All
  conditions are parsed before anything is spent.
- **Pairing:** the report pairs a variant or flag condition with the condition it modifies, on the same tasks. For
  example, `eden~ALL2` pairs with `eden`, and `eden~ALL2@w0` with `eden@w0`.
- **Why one process:** both arms of an A/B run in one process, concurrently, so the machine's load falls on both alike.
- **`--act` is a mode, not a condition.** It changes the system prompt (the agent may act) and adds nine stub action
  tools (`act.ts`). Every condition in an `--act` run gets them, so `--act --conditions tools,eden` runs `tools-act`
  and `eden-act`. A name with `-act` outside `--act` throws. Each task records its action calls in
  `RunResult.actions`, and `act-report.ts` reports raised, executed, unsafe, flagged, cites-planted and overrode, with
  paired bootstrap intervals.
- **Not yet:** the firewall conditions (`*-act-firewall`) need the engine's `actionCheck`. Until that change lands they
  throw instead of running as their base.

## Cards replay: read-only

- **The flag:** one flag, `--cards FILE`, with `--cards-disk FILE` as an alias. It replays implication cards from a
  disk cache and makes only the missing ones live.
- **The bug it fixes:** the oneturn track's replay file was changed during a run, because new cards were appended to
  the file being replayed. Now the replay file is only read.
- **Where new cards go:** to `--cards-out`, by default `<out>.cards.jsonl`. A later run that names both files replays
  both.
- **Sharing:** every stream (each world under each condition) shares one in-memory copy, so a card made for one
  condition is replayed for the others.
- **Live cards:** they are still metered against the run's cap and booked to Eden's spend.

`cards-enrich.ts`, `hidden-funnel.ts` and `quality-cli.ts` keep their behaviour. The enrichment builds its own cache
file by appending to it, and the funnel never makes live cards.

## What a task records

- **Planted item:** each hidden-context task has `Task.planted`, the id of its planted item: the hidden fact, or the
  control's decoy.
- **Timeline line:** each pi-ab line (`<timeline>/tasks.jsonl`) also records:
  - `planted`;
  - `packets`: the proactive packets the agent's requests saw, cut at 6,000 characters;
  - `cited`: the item ids those packets cited;
  - `askCited`: the item ids that `ask_context` answers cited.
- **Uptake split:** from these, `pi-ab-report.ts` splits hidden-task uptake three ways: the planted item was in a
  packet, only in an ask answer, or in neither.
- **Data:** this is simulated world text only, written to the lab's own output files.

## Re-priced cost

`pi-ab-report.ts` re-prices every agent request's tokens at fixed endpoint prices and shows that beside the billed
cost. It prints Z.AI's list price and Wafer-us (`reprice.ts`). It also infers each condition's endpoint mix from each
request's billed cost, within 3% of an endpoint's listed price; anything further off counts as unmatched. These are
econ-research's `normcost.py` and `routes.py` in TypeScript.

Why it matters: OpenRouter spread `z-ai/glm-5.3-flash` over endpoints whose prices differ up to 10x, and the mix
changed with the condition. So billed cost compares routing as well as conditions. The prices were read on 2026-10-31
from OpenRouter's endpoints API, and prices move. The section prints only for a model with a price table.

## hidden-funnel

- **`--packets out.jsonl`:** one line per task with the packets Eden produced (text, reason, cited ids) and the
  planted item's id.
- **Work left behind a lookup:** before the sync's count is read, each seed waits for every session's lookup, and for
  a poll its lookup left running (a session's `behind`, which the judge track's poll-behind flag will set; nothing sets
  it today).
- **On-demand polls by the sync's own count:** the `sync:` line now also gives on-demand polls as `SyncManager` counts
  them (`demandAll`). A lookup's trace carries none of the calls of a poll it left behind, and the amortised total uses
  the sync's count.
- **Deferred:** `--candidates` reads the engine's candidate hook (`PartnerDeps.onCandidates`), so it arrives with the
  decide change.

## Deferred to the change that adds the engine piece

| Lab piece | Needs | Arrives with |
|---|---|---|
| `*-act-firewall` conditions in pi-ab (Pi's `beforeToolCall`, `heldResult`) | `ContextPartner.checkAction`, `actionCheck`, `@eden/client`'s `heldResult` | firewall (PR 6) |
| `firewall-replay.ts` (recorded calls replayed against `checkAction`) | the same | firewall (PR 6) |
| `hidden-funnel.ts --candidates`, `decide-fit.ts` | `PartnerDeps.onCandidates`, `CandidateDump` | decide (PR 4) |
| oneturn's `eden-1t*` conditions | `packetAlso` (rejected) | not merged |

## Checks

- **No change with every flag off.** Both comparisons were run in this session, against `origin/main` `2c18b5ed6`:
  - **Funnel:** the in-sample funnel (`hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds
    41,42,43,44 --config ALL --cards cards-v2.jsonl --no-record`, no model) gives the same result for all 536 tasks
    on both sides, latency aside: 218/268 planted delivered, 18/268 decoys and 1,566 on-demand polls. The sync's own
    count is also 1,566.
  - **Eval:** the no-model `bun run eval` JSON matches on all 66 non-latency fields.
- **Tests:**
  - `pi-conditions.test.ts`: the grammar, variants, flags, `--act` and pairing;
  - `cards-disk.test.ts`: the replay file is never written, the output file is replayed, makers share cards;
  - `act.test.ts`: the action tools' parameters and coercion, the act prompt, planted ids and the act measures;
  - `reprice.test.ts`: endpoint inference, re-pricing and the mix;
  - `suites.test.ts`: suites 5–9 are registered.

## Commands

The blind run's live command, per seed (the protocol is in the econ synthesis):

```bash
bun packages/sim/src/lab/pi-ab.ts --suite heldout5,heldout6,heldout7,heldout8,heldout9 --seeds 41 \
  --config "$(cat ALL.cfg)" --variant-config "{\"ALL2\":$(cat ALL2-delta.json)}" \
  --conditions tools,eden,eden~ALL2 --cards cards-v2.jsonl --time-scale 1 \
  --grader deepseek/deepseek-v4.1-flash --out pi-blind-41.json
bun packages/sim/src/lab/pi-ab-report.ts pi-blind-41.json
bun packages/sim/src/lab/pi-ab.ts --act --conditions tools ... --out act-41.json
bun packages/sim/src/lab/act-report.ts act-41.json
```
