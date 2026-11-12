# Where Eden struggles: a diagnosis of the final default on heldout19

Status: 2026-11-12. This note measures and does not tune. heldout19 was read once by B19 (D1048), and this re-run
uses it only to diagnose. No switch is chosen from it: every fix below needs its own pre-registered run on train and
a fresh held-out suite.

**The run.** It is lab-provider: all calls go to Anthropic's API through the lab transport (D97), with no OpenRouter
calls.

- The final default (`main`, engine identical to 93b1a1f3) runs on Pi (pi-agent-core 1.3.0) with B19's settings:
  - agent, cards, intent, reader and push check on Haiku 5.5, graded by Sonnet 5.5;
  - shipped coverage, plus the final enricher's own `:f3` lines for heldout19;
  - `--tenant-prompt`, `--push payload`, and the direct market profile.
- Arms: `both+ask` (Eden) and `tools` (the agent alone).
- Tasks:
  - seeds 41–44, one request a session, with hidden, control and neutral variants (160 tasks each);
  - two days of 20 requests for four users.
- Each template is labelled from the suite's own header comments (phrasing, language, word overlap, anchored,
  silent edit, rare source, look-alike kind, area, source).
- The same tasks also ran through the no-model funnel (`--coverage full`, with candidate and ask dumps). That shows
  where in the pipeline a fact is lost.
- Spend: $1.94. Scripts: `packages/sim/lab/h19-diag/`. The outputs live in `.local/diag/`, which is not committed.

**It reproduces B19:**
- Eden raises 79 of 160 hidden facts (49%), against B19's 47.5%; the agent alone raises 25 (16%).
- False concerns: Eden 1 of 320 (control and neutral), the agent alone 0.
- Over days: Eden 7 of 16, the agent alone 1 of 16.

## Where each missed fact is lost (one request a session, 160 hidden facts)

| outcome | facts | share |
| --- | ---: | ---: |
| Raised by the agent | 79 | 49% |
| Never reached the agent: Eden's no-model pipeline never retrieved it | 50 | 31% |
| Never reached the agent: retrieved, but the push check (Haiku) dropped it | 15 | 9% |
| Reached the agent, which did not raise it | 16 | 10% |

When Eden's packet carries the fact, the agent raises it 81% of the time (67 of 83). When neither the packet nor
`ask_context` carries it, the agent finds it by its own search only 13% of the time (10 of 75).

**1. Retrieval is the main loss (50 facts, 31%), and the cause is the intent bridge, not missing cards.**
- 42 of the 50 planted items were carded, and 27 had a card call's anticipated requests.
- None of the 50 matched the user's request in the intent index: intent match was 0 of 50, against 62 of the 90
  that reached the agent.
- The index is BM25 over the anticipated requests, with a coverage floor of 0.2 (`intent.ts`). It misses whenever
  the user's words differ from the anticipated ones, even when the meaning is the same:

| the user's request | the anticipated request on the planted item's card |
| --- | --- |
| "Domani voglio spostare 5.000 sterline dai risparmi al conto corrente." | "move money out of the fixed saver" |
| "Preciso marcar o voo para Toronto no dia 3 de dezembro." | "book flights for December" |
| "Get me a return to Edinburgh on the 17th, I'll expense it." | "book a train to the client visit" |
| "Should I sell some of my Vanguard holdings before Christmas?" | "sell the investments this month" |
| "I'm going to paint over the damp patch on Saturday." | "repaint the hallway ceiling" |
| "I want to put a coat rack up in the hallway this weekend." | "hang a picture in the hallway" |

So the card call anticipated the right intent; the literal match lost it. Earlier work covers nearby ground but not
this case:
- Embeddings over raw item text were measured and not taken (D450–D452).
- Micro intent expansion stopped (M11, D970).
- Matching a request against short anticipated requests, multilingually, has not been measured.

**2. The push check drops a fifth of what retrieval finds (15 facts, 9%).** The no-model pipeline handed over 90
hidden facts and 55 look-alikes. The live push check keeps 72 of the facts and 29 of the look-alikes.
- The agent itself rejected look-alikes well: of the 29 handed over, it raised a false concern on 1.
- So part of the check's precision may cost facts the agent would have sorted out anyway.
- The dropped facts are mostly short notices in group chats and residents' portals: `goods-lift-extended` and
  `bays-suspended` 4 of 4, `regalo-spa` and `figures-wait-for-countersign` 3 of 4.

**3. A fact that reaches the agent is missed when the item states a change but not why it matters (16 facts,
10%).**
- 13 of the 16 are calendar or drive items, 11 of them silent edits, for example `onsite-runs-later` and `grown-ups-only-now` 4 of 4.
- The packet holds the event as it now reads ("workshop 14:00–17:30"), but nothing ties it to the request ("the
  16:40 train home"). The agent does not do the clash arithmetic itself.
- Packet size does not explain it: 1.9 items against 1.8 when raised.

## The splits (Eden raised, with the agent alone in brackets; n = hidden tasks)

| split | weak | strong |
| --- | --- | --- |
| Phrasing | indirect plans 35% (15%, n 48); statements 39% (25%, n 28) | imperatives 61% (18%, n 44); questions 60% (8%, n 40) |
| Word overlap with the fact | none 34% (10%, n 104) | a name 70% (n 40); a topic word 100% (n 12) |
| Language | non-English 29% (0%, n 28). In the funnel, Dutch, French, Italian and Portuguese reached 0 of 16 | English 54% (19%, n 132) |
| Silent edits | 42% raised; 57% reached, but 28% reached and not raised | other 52% |
| Area | health 15%, home 30%, family 35%, work 35% | admin 80%, money 80%, social 75% |
| Source | whatsapp 12%, calendar 25% (50% reached and not raised), tasks 0% (n 4) | crm 100%, residents 75%, trips 75% |
| Rare sources | 46% (alone 29%): the agent's own search finds residents and trips items that Eden's packet does not carry | — |
| Look-alike kind | (c) "the condition is met" 45% | (a) resolved or expired 52%, (b) another entity 50% |

Eden against the agent alone, task by task: Eden raised 56 facts the agent missed, and the agent raised 2 that Eden
missed (both `goods-lift-extended`, which the push check dropped). The agent makes 1.55 tool calls a task with Eden
against 2.76 alone.

## What this points at (hypotheses to test, none adopted)

1. **Match requests by meaning and across languages, not by literal words** (the biggest loss, about 31% of facts).
   Candidates:
   - a small multilingual sentence encoder over the anticipated requests (short phrases, not item text: unmeasured),
     beside BM25;
   - the card call writing its anticipated requests in more phrasings: indirect plans, and the user's own language.
     This costs output tokens but no new call;
   - normalising the request to English when it is not English.

   The precision guard is the look-alike, since the decoy's card anticipates the same requests.
2. **Re-tune the push check toward recall** (about 9%), now that the agent is measured to reject look-alikes itself.
   Guard: false concerns and neutral packets (silence).
3. **Say why an item matters when it changed or clashes** (about 10%). For a silent edit, deliver the old and new
   value. For a time on the request, state the clash ("moved to 14:00–17:30; overlaps the 16:40 train"). The
   no-model grounding already computes dates; this is packet wording.
4. Rare sources and whatsapp: check that the push check is not discounting short chat and notice items.
