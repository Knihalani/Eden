# Task-kind filtering: reduced-traffic A/Bs

Hermes and Pi accept `--kinds hidden,control` (also `neutral`, and the short-horizon `request`, `arrival`,
`offworld` kinds). Omission means full traffic. Explicit filters are canonicalised and recorded as
`taskSelection: { kinds: [...], mode: "reduced-traffic" }`. Empty, unknown and globally unmatched selections
are errors. The selection is execution-only: it does not change `--variants`, `--mix`, world generation,
the full `tasks` metadata, task wording/IDs/gold labels, original day sizes or seeds.

## What stays, what changes

Both loops retain every original clock slot and its background sync tick/notification. They initialise days at
their original boundaries and retain the original recap tasks, irrespective of the recap's inherited kind.
The original planted items, including those belonging to omitted kinds, still move before each recap;
sources are reindexed and recap notifications are retained. Even a day without selected requests still runs
its recap. Day-log turn counts include the original slots; results and selected/planned counts count actual
ordinary tasks. All arms in one invocation use the same filter.

Neutral tasks are **not state-neutral**. Hermes' source MCP tools call the same `SimSource` objects throughout
a stream. `callGuards` consumes seeded latency/error draws and rate-limit tokens on every call; this also
happens at time scale zero (latency draws are made before scaling). Default profiles are `REALISTIC`.
The paid reference contains, for example, 29 raw-Hermes tool calls on neutral request
`w42:heldout19-neutral:jab-already-booked`. Omitting such calls cannot preserve connector RNG/quota state.
Neutral answers also become same-day agent history; their Eden observations and lookups affect later caches,
session deduplication and delivery history. Replaying identical state would require the omitted interactions.

A free countercheck with identical seed-41 connectors, one with an extra read, produced next RNG draws
0.31426561216358095 versus 0.25017507828306407. A check against direct-world-mutation as the explanation
found neutral tasks plant nothing, but their slots **are cleared during world construction** (`pi-user.ts`);
that is why filtering the input plan would also be wrong. Here the full plan is constructed first.

This deliberately measures a **different traffic stream**, not neutral-free scoring of the old stream.
Do not interpret comparisons with historical full-traffic runs as the same experiment. Both paired reports,
benchmark-ledger comparison and Pi arm reuse reject different filters, or filtered against unfiltered/legacy
metadata. Journal argv retains `--kinds`, so resuming with a changed filter is also refused. Ledger summaries
and every compressed task row record the selection. The full plan remains in the results for auditability.

Pi filtering refuses connect, late-arrival, action and silent-edit modes: their additional task-driven world
mutations need separate preservation work. Unfiltered modes are unchanged.

## Free cost projection

Dry-run itself sends no model requests. Neither harness previously projected a dollar amount; use
`--project-from` to supply empirical costs rather than inventing a token budget. The complete reference must
have the same ordered full task IDs/kinds, arm names, agent and grader models. Per-kind agent/Eden costs and
the average grader cost are multiplied by selected counts. Remaining reference spend (including recaps,
backfill and background enrichment) is kept fixed, not reduced by the neutral fraction. It is a rough historical
estimate: shorter transcripts, different tool choices, model routing, configuration and checker health can
change costs. Model/grader or arm/plan mismatches and incomplete/error references are rejected.

Example: the existing lh10-setup three-arm reference, four seeds and ten days (no new paid calls):

```sh
bun run packages/sim/src/lab/hermes-ab.ts \
  --hermes-src /home/ubuntu/diag-1122/paid/hermes-agent \
  --model deepseek/deepseek-v4.1-flash --grader deepseek/deepseek-v4.1-flash \
  --card-model deepseek/deepseek-v4.1-flash --reader-model deepseek/deepseek-v4.1-flash \
  --check-model deepseek/deepseek-v4.1-flash \
  --days 10 --day-size 12-16 --mix 1:1:6 --seeds 41,42,43,44 --suite heldout18,heldout19 \
  --conditions hermes,hermes+eden,hermes+eden+pushCheckedWhy+packetCoversLine+pushUnsureAskNudge+edenGuide+pushConstraintStemSeats+pushPartyOrgLink \
  --project-from /home/ubuntu/diag-1122/paid/trials-stack-1122.json --dry
```

Repeat with `--kinds hidden,control`. The reference had failed/truncated push checks, so this is a cost reference,
not a clean checked-uptake baseline or evidence of filtered-run quality. No filtered paid outcomes are claimed.

Measured dry-run projections for that recipe (three arms, four users, ten days each):

| Selection        | Tasks per arm | Graded tasks, all arms | Projected total |
| ---------------- | ------------: | ---------------------: | --------------: |
| Unfiltered       |           561 |                  1,683 |         $5.7887 |
| `hidden,control` |           160 |                    480 |         $2.2217 |

Both retain $0.8218 of reference recap/background overhead, including all 120 recap turns. Projected saving:
$3.5670 (61.6%). Agent/grader call counts fall, but the projection does not assume retained turns get cheaper.

## Tests

`task-kinds.test.ts` covers canonical/invalid filters, unchanged plan/world/clock/recap traces, filter identity,
arm-reuse rejection and a network-blocked Pi integration using the existing fake OpenRouter transport.
The latter checks agent/grader counts, original tasks and days, recap changes (including omitted planted
kinds), same-filter paired reports, cross-filter refusal, dry projection and captured ledger summary/task rows.
`task-projection.test.ts` covers all/filtered/neutral/empty projections and invalid or mismatched references.

```sh
bun test packages/sim/src/lab/task-kinds.test.ts packages/sim/src/lab/task-projection.test.ts
CHECK_SERIAL=1 bun run check
```
