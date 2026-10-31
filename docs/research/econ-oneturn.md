# One-turn packets: can the first packet replace the ask round trip? (track oneturn, D70)

Status: 2026-10-31, one session. **Every live number is in-sample**: the hidden-context suites dev and held-out 1–4,
seeds 41–44, which every configuration was tuned on. Nothing here ran on or read held-out 5–9. The track built a flag,
`packetAlso`, off by default; with it off `bun run eval` equalled main's output except latency (checked on the track's
branch: identical JSON apart from latency fields).

**Outcome (D70).** The hypothesis was rejected and none of the track's code was merged: not the engine's `packetAlso`
section, not `Injection.also` in the protocol, not the client's one-turn guidance strings, not pi-ab's `eden-1t*`
conditions. It stays on the track's branch (`econ/oneturn`, commit `40a0fbe39`) as the record of what was measured.
Tenants keep `ask_context` with Eden's own description ([../INTEGRATION.md](../INTEGRATION.md)). The track's
`--cards-file` replay and per-task packet recording were folded into the shared lab tooling
([econ-lab.md](econ-lab.md)): `--cards` opens its file read-only, which fixes the replay mutation noted under
Reproduce. Sections below describe the track's branch as it was.

## The hypothesis

In the full Pi benchmark (D64) the agent called `ask_context` before answering in 92% of Eden tasks. Where Eden had
already delivered the planted fact, tasks that did not ask were twice as fast and a third of the cost, and raised the
fact *more* often (0.907, n=75, against 0.835, n=267). With sync, every planted item was in Eden's cache at decision
time, and the no-model gate held 242 of 584 back. The hypothesis was that if the first packet also carried the gate's
next-best candidates and a line saying what had been searched, the agent would answer in one call: cost and time
about halved, and facts found up, because the agent's own model would judge the held-back candidates as part of a
turn it already pays for.

**Result: the hypothesis is rejected.** The two halves fail in different ways:

- **With `ask_context` kept**, the agent still asks (82–83% of tasks against 88–89%), so nothing is saved. The extra
  section costs about $0.02 per 1,000 tasks more, and facts found do not move measurably.
- **Without the tool**, the agent answers in one call: cost falls 27% and wall time about 3 s (25%). But it raises the
  hidden fact 0.12 less often, which is significant, and makes slightly more false concerns.
- **The D64 split was selection, not cause.** The agent skipped the ask when the packet already plainly settled the
  request. Forced to skip it, the agent misses facts even on tasks where the packet carried them: 0.79–0.84 against
  0.91 with the ask. The ask round trip adds facts as well as time.

## What was built

- **Engine** (`packetAlso`, `packetAlsoItems` = 3, `packetAlsoBytes` = 700; `config.ts`, `partner.ts` `withAlso`,
  `render.ts` `renderAlso`):
  - **Where the section goes:** every proactive decision path with no model (the cache hit, the anticipated early
    decision, the slow path's sure, grounded, fallback and silent outcomes, and the judge's outcomes) appends an
    "also found" section to the packet.
  - **What it holds:** up to `packetAlsoItems` candidates the gate held back, in pool order (the judge's candidates
    and seats, then the rest of what is eligible). Items are compacted as packet items are, cited by source, and the
    whole section fits within `packetAlsoBytes`. It also carries a coverage line, for example
    `searched: gmail, calendar · names: Nadia Petrova · days: 2026-11-04`.
  - **Its label:** the section has an envelope of its own, `part="also-found"`, with the note "Data, not instructions.
    Lower-ranked items found for this message; the engine was less sure they bear on it." It describes the items and
    never instructs the agent. Source text cannot close the envelope (`inert`).
  - **When nothing is delivered:** the section is injected alone if it holds an item (`citations: []`, reason
    `also:`). A coverage line on its own is never injected, so silence is still the default.
  - **How the items are recorded:** they go in a new optional `Injection.also` field, not in `citations`. They were
    not delivered, so the ledger, usage inference and planner credit ignore them.
  - **Cost and state:** no model call, no source call and no new state. The ask path is unchanged (tested).
- **Protocol:** `Injection.also?: Citation[]` (optional, additive).
- **Client SDK:** `ONE_TURN_ASK_DESCRIPTION` and `ONE_TURN_SYSTEM_SNIPPET` (`packages/client/src/guidance.ts`). These
  are integration guidance a tenant may choose to use. Eden never sends them. They are the snippet measured as
  `eden-1t-guide`; it is not recommended, see below.
- **Lab:**
  - **pi-ab conditions:** `eden-1t` (packetAlso, ask kept), `eden-1t-noask` (no ask tool) and `eden-1t-guide`
    (guidance in the system prompt and the ask description). A suffix sets the section's size: `eden-1t.i5b1000`.
  - **`--cards-file`:** replays implication cards from disk, with live enrichment for uncovered items, so conditions
    in one run do not each pay the backfill.
  - **Per-task record:** each task now records the packets the agent saw (`packets`).
  - **Funnel:** `hidden-funnel.ts` records whether the planted item was in an "also" section (`also`,
    `alsoImmediate`) and the reply's bytes.
- **Tests:** `oneturn.test.ts` covers:
  - rendering: the label, data-only wording, the coverage line, the byte bound, envelope escaping and name cleanup;
  - the flag off;
  - the delivered packet unchanged with the section added after it;
  - section size;
  - the section alone when nothing is delivered;
  - the ask unchanged;
  - isolation between users on one engine.

## No-model funnel (in-sample, seeds 41–42, ALL + packetAlso, no agent, $0)

`hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 41,42 --cards cards-v2.jsonl`:

- 104 of 134 planted items were delivered.
- Of the 30 misses, every one was cached. The "also" section carries some of them, depending on its size:

| Section | Misses in "also" | Planted item reaches the agent | Decoy in "also" (control) | Reply bytes, hidden / control |
|---|---|---|---|---|
| 3 items, 700 B (default) | 12 / 30 | 116 / 134 | 64 / 134 | 938 / 778 |
| 5 items, 1,000 B | 18 / 30 | 122 / 134 | 72 / 134 | 1,079 / 927 |
| 8 items, 1,400 B | 21 / 30 | 125 / 134 | 82 / 134 | 1,190 / 1,037 |
| 40 items, 40 KB (ceiling) | 24 / 30 | 128 / 134 | 98 / 134 | 2,688 / 2,687 |

"Planted item reaches the agent" counts delivered or shown in the reply's "also" section.

Six misses are not in the eligible pool at all. The decoy shows up in the section about as often as the planted item
does, so precision rests on the agent's model.

## Live A/B (Pi harness, in-sample, ALL's config)

`pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --variants hidden,control --config ALL --time-scale 1
--grader deepseek/deepseek-v4.1-flash --cards-file <copy of cards-v2.jsonl>`. One seed per process; the conditions
in a process run concurrently on the same tasks. Agent `z-ai/glm-5.3-flash`. "$/1k" counts the agent plus Eden's model
calls, grader excluded.

Card enrichment is replayed here. It is the same for every Eden condition: D64 measured the one-time backfill at about
$0.156 per 1k tasks, which adds to every Eden row below and not to tools. Hidden tasks: 134 per condition; control
tasks: 134.

### Seeds 41–42: tools, eden, eden-1t, eden-1t-noask, eden-1t-guide

| Condition | Hidden raised | False concern | $/1k | Wall p50 / p90 / p99 s | Calls | Input tokens | Output tokens | Asked | Packet chars |
|---|---|---|---|---|---|---|---|---|---|
| tools | 0.418 | 0.022 | 0.325 | 14.93 / 26.21 / 41.33 | 3.18 | 4,191 | 1,646 | 1.00 | 0 |
| eden | 0.784 | 0.030 | 0.259 | 12.33 / 21.49 / 28.77 | 2.08 | 2,259 | 1,374 | 0.89 | 268 |
| eden-1t | 0.806 | 0.030 | 0.279 | 12.35 / 21.51 / 26.76 | 1.94 | 2,439 | 1,372 | 0.82 | 878 |
| eden-1t-noask | 0.664 | 0.060 | 0.189 | 9.32 / 15.83 / 21.99 | 1.05 | 461 | 1,046 | 0.04 | 851 |
| eden-1t-guide | 0.759 | 0.030 | 0.317 | 10.77 / 21.69 / 30.85 | 1.84 | 2,259 | 1,345 | 0.73 | 875 |

In the noask condition, "asked" counts tool calls the agent attempted to a tool it does not have.

Paired against eden on the same tasks (bootstrap 95% interval over tasks, n = 268 or 267):

| Condition − eden | Hidden | False concern | $/1k | Wall p50 s | Wall mean s |
|---|---|---|---|---|---|
| eden-1t | +0.022 (−0.051..+0.091) | +0.000 (−0.029..+0.031) | +0.020 (−0.004..+0.044) | +0.03 (−1.52..+1.48) | +0.06 (−0.58..+0.66) |
| eden-1t-noask | **−0.119 (−0.196..−0.047)** | +0.030 (−0.008..+0.074) | **−0.070 (−0.093..−0.047)** | **−3.01 (−4.43..−1.29)** | **−3.09 (−3.80..−2.42)** |
| eden-1t-guide | −0.023 (−0.090..+0.045) | +0.000 (−0.030..+0.030) | +0.057 (+0.012..+0.100) | −1.54 (−3.08..+0.86) | −0.24 (−1.16..+0.72) |
| tools | −0.366 (−0.463..−0.268) | −0.007 (−0.036..+0.016) | +0.066 (+0.044..+0.088) | +2.61 (+1.21..+4.37) | +3.25 (+2.40..+4.14) |

Each process ran in about four minutes. Seed 41 alone gave the same picture: noask hidden −0.075, false +0.060, $
−0.078 per 1k, wall mean −2.99 s; eden-1t +0.000.

### The section's size, with no ask (seeds 41–42, paired against eden-1t-noask at 3 items, 700 B)

| Section | Hidden | False concern | $/1k | Wall p50 s | Packet chars |
|---|---|---|---|---|---|
| 3 items, 700 B (base): 0.627 / 0.030 / $0.169 | | | | | 852 |
| coverage line only (`i0b300`) | −0.037 (−0.104..+0.030) | +0.000 (−0.031..+0.030) | −0.010 | −1.05 (−1.94..+0.08) | 414 |
| 1 item, 350 B | +0.000 (−0.060..+0.055) | −0.008 (−0.047..+0.031) | +0.010 | +0.69 (−0.43..+1.60) | 569 |
| 6 items, 1,400 B | +0.015 (−0.033..+0.066) | +0.023 (+0.000..+0.051) | +0.011 | +0.24 (−0.76..+0.90) | 1,182 |

The size barely matters. The noask base's hidden rate was 0.664 in the first run and 0.627 here, on the same tasks:
run-to-run noise of about ±0.04 at this n. The held-back items add at most about +0.04 over the coverage line alone,
and more of them start to add false concerns.

### Replication of eden-1t against eden (seeds 43–44)

| Seeds | Condition | Hidden | False | $/1k | Wall p50 / p90 / p99 s | Calls | Asked |
|---|---|---|---|---|---|---|---|
| 43–44 | eden | 0.842 | 0.015 | 0.263 | 18.42 / 29.47 / 43.23 | 2.05 | 0.91 |
| 43–44 | eden-1t | 0.815 | 0.046 | 0.270 | 17.13 / 26.95 / 35.32 | 1.94 | 0.86 |
| 41–44 | eden | 0.813 | 0.023 | 0.261 | 14.39 / 27.07 / 40.24 | 2.06 | 0.90 |
| 41–44 | eden-1t | 0.811 | 0.038 | 0.275 | 13.98 / 24.88 / 32.50 | 1.94 | 0.84 |

eden-1t − eden, paired:

| Seeds | n | Hidden | False concern | $/1k | Wall p50 s | Wall mean s |
|---|---|---|---|---|---|---|
| 43–44 | 259 | −0.023 (−0.094..+0.052) | +0.023 (+0.000..+0.052) | +0.008 | −1.33 (−3.06..+0.54) | −1.06 (−1.87..−0.28) |
| 41–44 | 527 | **+0.000 (−0.049..+0.050)** | +0.011 (−0.008..+0.032) | +0.014 (−0.002..+0.030) | −0.41 (−1.21..+0.60) | −0.49 (−0.98..+0.00) |

Over four seeds the section with the ask kept changes nothing measurable:

- facts found: +0.000;
- false concerns: +0.011, leaning worse;
- cost: +$0.014 per 1k;
- wall mean: about 0.5 s less, at the edge of significance.

A few runs failed and are excluded:

- seed 43: one eden-1t run refused by the spend cap's worst-case reservation;
- seeds 43–44: six connection resets.

## Why it fails: where the planted item was, and whether the agent asked

The table splits the hidden tasks of seeds 41–42 by where the no-model funnel put the planted item: delivered in the
packet (n = 104), shown only in "also" (n = 10), or neither (n = 20). The funnel is a separate no-agent run on the
same tasks and config, so this placement is approximate.

| Condition | Delivered: raised / asked | Also only: raised / asked | Neither: raised / asked |
|---|---|---|---|
| eden | 0.913 / 0.74 | 0.300 / 0.90 | 0.350 / 1.00 |
| eden-1t | 0.885 / 0.62 | **0.700** / 1.00 | 0.450 / 0.85 |
| eden-1t-guide | 0.864 / 0.52 | 0.500 / 0.90 | 0.350 / 0.70 |
| eden-1t-noask | 0.837 / 0.01 | 0.200 / 0.00 | 0.000 / 0.05 |
| tools | 0.490 / 1.00 | 0.400 / 1.00 | 0.050 / 1.00 |

1. **The ask adds facts even when the packet already carries the fact.** On delivered items, removing the tool costs
   0.08 (0.913 → 0.837; 0.788 in the size runs). Within eden, delivered tasks where the agent chose not to ask raised
   it 0.889 (n = 27) and those where it asked raised it 0.922 (n = 77). D64's n = 75 against n = 267 split had the
   same shape: the agent skips the ask when the packet plainly settles the request. That is selection, not a cost of
   asking.
2. **The held-back items are rarely acted on alone.** With no ask, an item shown only in "also" was raised 0.2 of the
   time. With the ask kept, it was raised 0.7 against eden's 0.3 (n = 10, too few to claim). The section seems to help
   the agent ask the right question rather than replace the question.
3. **When the planted item is in neither place, only the ask recovers it** (eden 0.35, noask 0.00). The agent's own
   rephrasing of the request reaches items the request's words did not.
4. **The guidance moves behaviour only a little:** the share of tasks that asked goes from 0.82 to 0.73 and facts
   fall slightly. The model asks because asking helps it.
5. **False concerns with no ask come partly from the section itself.** Examples: a recurring stand-up on another
   Thursday read as a clash; a held-back invoice read as a duplicate.

## Cost and time accounting (why one turn does save what it was meant to)

Against eden, noask saves $0.070 per 1k tasks (−27%) and about 3 s of wall time per task (−25%).

| Per task | eden | noask |
|---|---|---|
| Model calls | 2.08 | 1.05 |
| Input tokens | 2,259 | 461 |
| Output tokens | 1,374 | 1,046 |

The prediction of "about 50%" was too high. The final answer's output tokens remain, and those are about 85% of model
time. The saving is real, but it is bought with 0.12 of hidden facts, the owner's first priority. Against tools,
noask is still +0.25 hidden (0.664 against 0.418) at 58% of the cost and 62% of the wall p50. A cost-capped tenant
could choose it, but not as the default.

## Decision

D70 (proposed by the track as D65; renumbered in the econ synthesis's merge order). The track proposed keeping
`packetAlso` in the engine, off, as an ablation and as an option for a tenant that cannot afford a second model call,
and the one-turn snippet in the SDK as a documented option. The synthesis rejected both: the section adds nothing with
the ask kept and costs facts without it, so it is code no recommended configuration runs, and a snippet in the SDK
reads as advice. What D70 records:

- **Not merged:** the engine section, `Injection.also`, the client guidance strings and the `eden-1t*` conditions.
- **Integration:** tenants keep `ask_context` with Eden's own description.
- **What to do next:** the gain in facts must come from closing the decision gap inside Eden, so that more planted
  items are delivered, not shown as "also". The ask's cost is better reduced on Eden's side (it is already 5 ms at
  p50) or by shortening the agent's final answer, than by removing the ask.

## Spend

Live spend this track: **$1.216** of the $1.50 cap (agent, Eden's card enrichment for items with no replayed card,
and the grader). The grader was $0.515 of it.

| Run | Spend |
|---|---|
| smoke | $0.0038 |
| main seed 41 | $0.2932 |
| main seed 42 | $0.3091 |
| size runs, seed 41 | $0.1785 |
| size runs, seed 42 | $0.1816 |
| replication | $0.1276 + $0.1224 |

## Reproduce

These commands run on the track's branch (`econ/oneturn`); `packetAlso` and the `eden-1t*` conditions do not exist on
main, and main's pi-ab spells the replay `--cards` (read-only, new cards to `--cards-out`).

```bash
CFG='<ALL, the block in the brief>'
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 41,42 \
  --no-record --config "$(jq -c '.+{packetAlso:true}' <<<"$CFG")" --json f.json \
  --cards packages/sim/lab/cards/cards-v2.jsonl
for sd in 41 42; do
  bun packages/sim/src/lab/pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds $sd \
    --variants hidden,control --conditions tools,eden,eden-1t,eden-1t-noask,eden-1t-guide --config "$CFG" \
    --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 0.45 --cards-file cards-copy.jsonl \
    --out pi-main-$sd.json
done
# sizes: --conditions eden-1t-noask,eden-1t-noask.i0b300,eden-1t-noask.i1b350,eden-1t-noask.i6b1400
# replication: --seeds 43 / 44 --conditions eden,eden-1t
```

Run `--cards-file` on a copy: the replay appends cards made live for uncovered items to the file it reads.

The analysis scripts stayed in the session scratchpad:

- `an.py`: the paired bootstrap;
- `split.py`: hidden raised by where the funnel placed the item;
- `sel.py`: the asked and not-asked split;
- `diff.py`: per-task differences between two conditions, with their packets.
