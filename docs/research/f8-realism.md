# F8: `--realism heavy`, a heavy real user's sources (D1103)

Status: adopted (tooling), 2026-11-12. A lab switch, no engine change.

## Why

The sim's worlds hold about 1,500 items a user, and only about 100 of the cards made from them read as rules (kind
not none). A heavy real user's mail and apps are full of constraint-worded text that does not apply to them. F5's rule
sheet and F10's semantic rule index match requests against rule cards, so they need a user whose cards number in the
hundreds and are mostly irrelevant before their precision means anything.

## What it adds (`packages/sim/src/realism.ts`)

`addRealism(world, seed)` runs in `prepareWorld`, before planting, with a fixed seed and no model. It gives every world
twenty connectors: the world's five, the eight rare ones, and seven more (outlook, shopping, airline, utilities,
insurance, dropbox, teams). Per world it adds 600 items, all `noise` with no facts, so none is ever planted for a task:

- 400 rule-like items that never apply. Each is one of these kinds:
  - newsletters whose offers ended, with their terms;
  - change freezes that are over;
  - other companies' travel, expenses and visitor policies;
  - automated holds that were resolved;
  - terms and conditions;
  - cancelled bookings;
  - colleagues' own deadlines;
  - airline fare rules for fares the user does not hold;
  - meter and renewal notices already handled.

  About one in seven is in Spanish, German, French, Italian or Portuguese.

- 60 forwarded or re-quoted copies of the world's own mail threads (in gmail or outlook).
- 140 plain items, 20 for each new connector.

The items depend only on the seed, so every suite's world for a seed gets the same ones. `--realism heavy` is the
hidden funnel's flag (`bun run funnel --suite train --seeds 41,42 -- --realism heavy`); `cold-start.ts` takes it too.
`realism.test.ts` pins the counts, the determinism, the profiles and the same-items-in-every-suite rule.

## Its cards

The realism items' cards and requests were served by subagents per item on the world's clock (D1102's transport):

- 1,534 new items over seeds 41–44;
- one recording pass on train1 seeds 41–44 under `--realism heavy`, both prompt forms, 302 calls, 0 failures;
- only the realism items' lines kept (3,028 lines in `cards-shipped.jsonl.gz`).

A run without `--realism` never reads those lines, so every other baseline is unchanged (train 41–42 still 318/299).

Rule cards a user (kind not none, form 3, train1's world):

| Seed | Items         | Carded off | Rule cards off | Carded heavy | Rule cards heavy |
| ---- | ------------- | ---------- | -------------- | ------------ | ---------------- |
| 41   | 1,507 → 2,104 | 269        | 107            | 663          | 350              |
| 42   | 1,511 → 2,107 | 284        | 108            | 668          | 347              |
| 43   | 1,515 → 2,112 | 269        | 109            | 667          | 344              |
| 44   | 1,513 → 2,107 | 268        | 99             | 658          | 333              |

## The main baseline under it ($0; default preset, stub reader, shipped coverage)

|                           | train 41–42, off | train 41–42, heavy | dev20 41–44, off | dev20 41–44, heavy |
| ------------------------- | ---------------- | ------------------ | ---------------- | ------------------ |
| hidden surfaced           | 318/384          | 311/384            | 292/640          | 276/640            |
| decoys surfaced           | 299/384          | 288/384            | 216/640          | 203/640            |
| hidden handed by the push | 296/384          | 284/384            | 210/640          | 202/640            |
| decoys handed by the push | 276/384          | 265/384            | 152/640          | 141/640            |
| neutral: any packet       | 378/384          | 382/384            | 385/640          | 421/640            |
| neutral: items handed     | 1,782            | 1,951              | 1,699            | 1,963              |
| neutral: packets          | 465              | 527                | 428              | 574                |

The commands were `bun run funnel --suite train --seeds 41,42 --json F -- --neutral [--realism heavy]`, and the same
for dev20. "Handed" counts each row's `pushHanded`; the neutral figures are the merged NEUTRAL block's.

In train's heavy packets (`--packets`), items from the seven new connectors make up 216 of the 1,807 items handed on
hidden tasks (118 tasks have one) and 434 of the 1,951 handed on neutral tasks (193 tasks). That is a lower bound:
realism items in the world's own connectors (gmail, slack, drive, trips) are not counted.

What it says:

- The default loses a few facts to the extra rule cards: 12 fewer facts handed on train, 8 on dev20.
- It sends more to requests that need nothing: neutral items +9.5% on train, +15.5% on dev20.
- It gives no sign of the decoy rate running away: decoys fall with hidden.

The reader and the push check are not in this screen (stub reader, no checker), so it does not show what the paid
path would reject.

## heldout20's realism items (for the final's secondary arm)

heldout20 lives at its own present (19 November 2026), so its realism items are dated differently from train's and
need their own cards. They were made from heldout20's **neutral** worlds only, seeds 41–44: a neutral world plants
nothing, so no template of the blind suite was read.

- The worlds were built on F4's branch merged with main, locally, without pushing.
- The items pending in the queue were the realism items plus that world's base items. The base items were answered
  too, so the card calls that mixed both could complete; only the realism items' lines were kept.
- Coverage: 2,075 realism item keys; 1,476 got a form-3 line, 952 of them rule cards. Both forms, 216 calls, 0
  failures, served by subagents per item (D1102) on heldout20's clock.
- The 2,952 lines are at the head of `cards-shipped.jsonl.gz`. Their keys appear in no other suite's world, so no
  other run reads them (train 41–42 still reads 318/299).
