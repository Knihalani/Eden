# A19: `heldout17`, the blind suite for the end-of-day confirmation

Status: 2026-11-07, branch `claude/a19-heldout17` (from `claude/lucid-hypatia-v9wqk5` at `20deee90`, after A12's
merge). Decision D350. **Lab only: no engine file changed.** Paid calls went to the Anthropic API with
`HAIKU_API_KEY`, `claude-haiku-5-5`, through the lab provider (D97), with `OPENROUTER_API_KEY` unset, on one ledger
(`.local/a19/ledger.jsonl`) with a hard cap of $0.3: **Anthropic-direct lab figures. Spent: $0.0337** (61 calls).

**No funnel or agent has run on `heldout17`.** It is reserved for the end-of-day confirmation; never tune on it.

## In plain words

- A new blind suite, `heldout17`, is written, registered and cached, and nobody has read its results.
- It has 32 everyday requests to a personal agent, four in each of eight life areas. Each has a hidden variant (a
  fact the request does not ask about but a good answer raises), a control variant (a near-miss look-alike that does
  not apply) and a neutral variant (nothing planted).
- Eight of the 32 (one per area) are written so their fact reads naturally as arriving later the same day, for
  `pi-ab --day K --late` (D302).
- Its cards and intent requests are cached for seeds 41–44 for $0.0337, and every planted item has requests.

## 1. How it was written (as heldout15 and heldout16 were)

`packages/sim/src/lab/hidden-heldout17.ts` was written by an author subagent. It read only:

- `hidden-heldout16.ts`, as the format;
- the `HiddenTask` interface, pasted into its brief;
- the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`);
- a short brief: 32 templates over 8 life areas; hidden, control and neutral; varied decoys and word overlap; about
  eight late-arrival templates.

It opened no engine, ranking, reader, prompt, card, intent, research or other suite file. It ran only a typecheck
and its own planting check. This session read the file's exports, its planting function, its template names and the
author's counts, and no template body.

By the author's count:

- **Templates:** 32, four per area (work, family, health, money, travel, home, admin, social), none reusing a
  heldout16 situation.
- **Word overlap with the request:** 10 share no content word, 11 share only a name, 11 share one topic word.
- **Decoys:** 11 resolved, expired or superseded; 11 about another entity or date; 10 where the condition is met or
  the item allows the request.
- **Late arrivals** (`HELDOUT17_LATE`, one per area): the hidden item and the decoy are dated 27 October 2026,
  08:05–08:50 UTC, just before the world's NOW, and read as a fresh change that matters after the agent acted.

## 2. Late arrivals: what the format supports

The suite format has no per-template arrival time. `pi-ab --day K --late` (pi-late.ts) holds every planted item of
the run back and releases it after its request is answered, so any template can be run late. The brief's eight are
the ones whose item reads naturally as a later arrival. Run only those with
`--templates $(the HELDOUT17_LATE names, comma-separated)`.

`--days` (a user's mixed days) has no late mode: `--late` needs `--day K`. In `--days` the eight templates are
planted up front like the rest. Adding a late mode to `--days` is not part of this change.

## 3. Registration and tests

- `SUITES.heldout17`, `UNRUN_BLIND` (kept out of `all`) and `NEUTRAL_SUITES`.
- `suites.test.ts`, at seeds 41 and 44:
  - 32 tasks per variant, and 32, 32 and 0 planted items;
  - the same text, detail and template across the three variants;
  - ids `w<seed>:heldout17[-variant]:`;
  - the suite stays out of `all`;
  - `HELDOUT17_LATE` holds 8 of the suite's templates.
- **No leak to the tools arm** (the A5/CL5 review's lesson, the agent sees refs): each planted item's ref has the
  base world's `<kind>-<index>` shape and is the same in hidden and control. The test checks that no item's ref, id
  or title contains a template name, `heldout`, `h17`, `planted` or `decoy`.

## 4. Caches

Made with `cards-enrich.ts --funnel heldout17 --seeds 41,42,43,44 --model claude-haiku-5-5` into a copy of the
checked-in files. The new lines were appended, so each old file is an exact prefix of the new one (checked with
`cmp`):

| Ledger run | What | Calls | $ |
| --- | --- | --- | --- |
| `a19-h17-cards` | cards, +167 items, into `cards-v2.jsonl` (5,153 → 5,320 lines) | 17 | 0.0111 |
| `a19-h17-intent` | intent, 212 items of 232 | 24 | 0.0203 |
| `a19-h17-intent-topup-b1` | the 20 items that came back without requests, one per call | 20 | 0.0022 |
| **Total** | | **61** | **0.0337** |

The intent file `intent-v2.jsonl.gz` now holds 8,243 lines (plain md5 `bff861de1eda6dd2ec2b79a4d1f85a4c`), and a
dry run finds 0 items left to enrich. `INTENT_COVERS` gains heldout17 for seeds 41–44.

`cards-disk.test.ts` checks that every planted item has requests at seeds 41 and 44. A one-off script checked all
four seeds: 256 planted items (hidden and control), 256 with a line, 0 with empty requests.

Commands (from the repo root; `--spend-headroom 0.02` because the default headroom, $0.5, is above a $0.3 cap and the
first attempt stopped before any call):

```bash
D=.local/a19/cards; mkdir -p $D
cp packages/sim/lab/cards/cards-v2.jsonl $D/
gunzip -c packages/sim/lab/distilled/intent-v2.jsonl.gz > $D/intent-v2.jsonl
C="--dir $D --funnel heldout17 --seeds 41,42,43,44 --model claude-haiku-5-5 --spend-ledger .local/a19/ledger.jsonl \
  --spend-cap 0.3 --spend-headroom 0.02 --cap 0.28 --spend $D/spend.jsonl"
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --run-label a19-h17-cards
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --intent --run-label a19-h17-intent
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts $C --intent --batch 1 \
  --run-label a19-h17-intent-topup-b1
cp $D/cards-v2.jsonl packages/sim/lab/cards/cards-v2.jsonl
gzip -9 -n -c $D/intent-v2.jsonl > packages/sim/lab/distilled/intent-v2.jsonl.gz
```

## 5. Merge notes

- The two cache files are append-only. If another branch also appended to `cards-v2.jsonl` or `intent-v2.jsonl.gz`,
  merge by concatenating the new lines: unzip the intent file, take both sets of new lines after the common prefix,
  then gzip again. Do not take one side's file.
- `cards-disk.test.ts`'s coverage test now builds 20 worlds; its timeout went from 120 s to 150 s.
