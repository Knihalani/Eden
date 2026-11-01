# Guided asking with a precision guard, and answer-shaped packets (track ask)

Status: 2026-11-01. Two flags, off by default (`askGuard`, `packetBearing`), proposed as D86. Every number comes
from a command run this session; the live smoke is labelled for what it is (16 runs, not a measure).

## The problem

`docs/research/path-to-90.md` measured a guided `ask_context` description live: facts +0.110, but false concerns
+0.078 and agent cost +13%. The agent's own model bridges the vocabulary gap when it is asked to probe for blockers,
and also grows cautious, because nothing in Eden's answer tells it when there is nothing to raise. Packets were also
used less than ask answers (0.88 against 0.99).

## What changed

All three are Eden's product surface. No source call and no model call: verdicts that are already computed.

1. **Guided description, shipped** (`packages/protocol/src/describe.ts`). `ASK_CONTEXT_GUIDED` asks the agent,
   before it acts, what could block, constrain or change the action, naming the people, things, dates and amounts,
   and adds: "Raise only what its answer shows; when it says nothing binds, go ahead." The MCP server gives it when
   `askGuard` is on (otherwise the standard description). The client SDK exports both. The lab's
   `pi-ab --ask-description guided` now reads the product constant, so the lab measures what ships.
2. **`askGuard`** (an ask about an action: the question is imperative or asks about rules, limits, holds and the
   like, or the session's request is imperative):
   - each answer item gets a bearing from the verdicts: "conflict" for an `askVerdicts` hit, a card the request's
     actions violate, or the conflict test's conflict; "clear" for its clearance. Bulk mail and settled updates get
     none.
   - What may block leads the answer, marked `May block or change this:` before its title. A mark only stands on a
     line that still states a constraint once compacted (`constrains` or the conflict test on the shown text), or on
     an item said "(shown above)", whose words the agent already has.
   - When nothing may block, and every source of the user was answered from a current synced copy, the answer's
     first line says so in fixed words: `Checked gmail, calendar, drive, crm, slack: no rule, hold, limit, absence or
     change found for Steve Hargreaves, 29 Oct.`
   - "Nothing may block" is conservative: no item marked, no item the conflict test reads as a conflict, and no item
     on or naming a day the question names. An appointment on the day has no word of a block and still clashes; the
     first version missed that (class-photo, below).
3. **`packetBearing`**: a proactive packet says each item's bearing the same way, what may block first.

Both are rendered by `renderPacket` from fixed words (`BEARINGS`, `guardLine`). The guard line carries only source
ids and the question's own names and days, cut short and made inert. Usage tracking and `askDedup` drop the guard
line and the bearing prefixes (`shownText`, `unbear`), so neither is read as the user's words.

Lab plumbing for free models: `--max-requests`/`--min-gap-ms` (`request-cap.ts`) cap and pace every chat attempt.
`--lab-routing open` drops D12's routing for Eden's own calls only when every model is `:free`. `--templates` picks
tasks. `priceFor` prices `:free` models at 0. `OpenRouterModel` takes `dataCollection`, defaulting to "deny";
`fromEnv` never sets it, so the production default is unchanged.

## No-model measure (dev6a + dev6b, seeds 41–42, 240 tasks, ALL3, `--ask`, full card replay)

`hidden-funnel.ts --suite dev6a,dev6b --seeds 41,42 --config ALL3[+askGuard+packetBearing] --cards
diag90/cards-all.jsonl --ask --packets …`.

Flags off against `origin/main`: every task's delivered, askCited, injected and packets are identical, and the bytes
are identical (220,082 both). `bun run eval` matches main's JSON except latency.

| | ALL3 | ALL3 + askGuard + packetBearing |
|---|---|---|
| Hidden delivered / ask-cited | 47 / 64 | 47 / 64 (same items) |
| Decoys delivered / ask-cited | 13 / 52 | 13 / 52 |
| Ask bytes (240 asks) | 165,543 | 178,198 (+7.6%) |
| Packet bytes | 54,539 | 56,989 (+4.5%) |
| All bytes | 220,082 | 235,187 (**+6.9%**, within +10%) |

What the agent now reads:

| | Hidden (planted item) | Control (decoy) |
|---|---|---|
| Ask answers citing it that mark it "May block or change this" | 46 / 64 (72%) | 6 / 52 (12%) |
| … that mark it "Says this is clear" | 0 / 64 | 16 / 52 (31%) |
| Packets carrying it that mark it "May block" | 36 / 47 (77%) | 5 / 13 (38%) |
| Asks answered with the guard ("Checked …: no rule … found") | 16 / 120 | 48 / 120 |
| Guard said while the planted item is cited | **0** / 64 | 23 / 52 (the decoy, correctly) |

Other items marked: 80 marks in the 120 hidden answers, 56 in the 120 control answers. That is the remaining
over-caution risk: some are real constraints of the world's noise mail (the "travel over £500 needs pre-approval"
reminders), which the conflict test reads as binding on any spend above £500.

Iterations, all on dev only:
- The first version marked items from the item's whole text: 48/64 hidden and 6/52 decoys marked, but it also put
  marks on lines compaction had cut to a sender and date. Marking from the shown text first cut the hidden marks to
  6/64, because most planted items in answers are "(shown above)", already delivered by a packet. Keeping the mark
  on those restored 46/64 and left the decoys at 6/52.
- The first guard fired 2 times with the planted item cited (class-photo: an orthodontist appointment on the asked
  day, no blocking word). Adding the day rule made it 0.
- A stricter mark (verdict hits and cards only, not the plain conflict test) changed almost nothing (other items
  marked in control 80 → 74), so the simpler rule stays.

## Live smoke (free models, labelled: not a measure)

`pi-ab.ts --suite dev6a,dev6b --seeds 41 --templates landlord-pays,processor-register,design-seats,entertainment-cap
--config ALL3 --variant-config '{"G":{"askGuard":true,"packetBearing":true}}' --conditions eden,eden~G
--ask-description guided --model nvidia/nemotron-3.5-super-vl:free --grader nvidia/nemotron-3.5-lightning:free
--lab-routing open --cards diag90/cards-all.jsonl --max-requests 58 --min-gap-ms 3500`. The four templates were
chosen because the flags change what the agent sees on them, which is a selection bias. Both arms got the guided
description.

The cap was 60 requests: 2 were spent on a one-task plumbing run and 58 on this one. 12 more were refused at the cap,
so 2 control runs of the flag arm ended in errors and 1 control run of ALL3 went ungraded. $0.

| | ALL3 (guided) | ALL3 + flags (guided) |
|---|---|---|
| Hidden raised | 4 / 4 | 4 / 4 |
| Control false concern | 0 / 3 graded | 0 / 2 graded |
| Agent model requests, hidden | 10 | 8 |
| Agent tool calls, hidden | 6 | 4 |

The flag arm's packets carried the bearing on 3 tasks. Every task was solved either way, so this smoke can only show
that the path runs end to end on the Pi harness with a free agent model, and that it did not break uptake. The
agent's ask answers are not kept in the timeline, so how often the guard reached the agent live is not known from
this run.

## Verdict

- Mechanism: works as designed on dev. On the decisive items it separates what binds from what does not (72% of
  planted against 12% of decoys marked; 31% of decoys marked clear, no planted item). The guard never contradicts a
  cited planted item and covers 40% of control asks. Bytes +6.9%.
- Live effect: **not measured**. 16 runs, 14 graded, no difference observable. The question is whether the guard
  claws back the guided description's +0.078 false concerns without losing its +0.110 facts. It needs the usual
  pre-registered paired A/B: dev first, then a fresh blind suite, `eden~ALL3` against `eden~ALL3+askGuard+
  packetBearing`, both guided. The 60-request budget could not hold that.
- Recommendation: keep both off; propose D86. Do not add to ALL3 until the live A/B shows false concerns at or below
  ALL3-guided with facts held.

## Cost

No model call and no source call. CPU: one conflict-test read per answer or packet item (cached per cue), and one
card verdict per item. Bytes +6.9% on dev. No COST-MODEL.md change: there is no new per-event model call.
