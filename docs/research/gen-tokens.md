# Tokens: what Eden makes the agent read, and what Eden's cards cost (D73, proposed)

Track `gen/tokens`. Goal: cut the agent input tokens Eden causes (packet bytes and `ask` answer bytes) and Eden's own
card spend, without losing a fact. Every number below comes from a no-model funnel run in this session
(`hidden-funnel.ts`, ALL configuration, `--ask`, `--cards packages/sim/lab/cards/cards-v2.jsonl` replayed, seeds
41–44, no OpenRouter call). Development suites dev6a and dev6b are reported apart from the old in-sample suites
(hidden, held-out 1–4); held-out 5–9 were neither run nor read.

## Where the bytes are

Baseline ALL, bytes the agent reads per task when it asks once (every task, hidden and control):

| | dev6a + dev6b (480 tasks) | in-sample (536 tasks) |
|---|---|---|
| bytes per packet | 309 | 340 |
| packets per task | 0.43 | 0.81 |
| bytes per ask answer | 1,195 | 1,254 |
| bytes per task (packets + one answer) | 1,328 | 1,528 |

The answer is 82–90% of the bytes. Packets were compacted by D47 (`compactInjection`); answers were not: `ask` rendered
up to five items whole, to 4 KB. A typical answer carried recipients, greetings, signatures, confidentiality footers,
and a reply's whole quoted thread.

## What changed (three flags, off by default)

- **`compactAsk`** (`partner.ts` `answering`): an answer's items are compacted as a packet's are (`compactText`,
  focus = the question's words, `askItemBytes` 320 each, `densePacket`'s dense parts when that flag is on). Dates stay
  as written, with their year: the first cut dropped the current year as packets do, and that was the only evidence
  word it lost in-sample (17 of 240 tasks). Items and their order are unchanged: citations are identical.
- **`askDedup`** (`Session.shown`, `noteShown`, `renderPacket`'s `shownBefore`): the words each item's line showed the
  agent in this session (packets and answers; a model-composed answer is attributed to no item) are kept per session,
  at most 64 items. An answer then says an item already shown by only its parts with a word not shown, or as
  `Title: (shown above)` when it has none. A packet's dates omit the current year, so the year counts as shown.
  Per session only: another session of the same user, and other users, are not affected (tested).
- **`compactParts`** (`render.ts` `messageParts`): compaction fixes, found reading the answers, that make it keep a fact
  it used to drop. (1) A nested quote's "On … wrote:" is split onto an unquoted line, so the first quoted sign-off ("—
  O") silenced the rest of the thread, where a reply's ask often is (the accountant's "P11D … by 30 November" three
  messages down). (2) A table a connector flattened to one line was one part longer than an item's room and was dropped
  whole; it is now cut at its rows. (3) The user's own sent mail keeps its `To:` (addresses stripped): its counterparty
  is named nowhere else ("Re: 2025/26 return" to Owen Price).

`cardsEconomy` (D66) is used as built: its strict prefilter, sentence reuse and 20-item calls.

## Results

Facts first: every configuration below leaves **every task's** `delivered` and `askCited` as in the baseline (checked
per task, both suite groups), and decoys delivered are unchanged. Retention: of the planted item's evidence words (the
detail's content words that its text holds), the share the agent holds over the task (packets and answer together),
over the tasks where the planted item was cited.

| configuration | dev bytes/task | dev answer | dev retention | in-sample bytes/task | in-sample answer | in-sample retention |
|---|---|---|---|---|---|---|
| ALL (baseline) | 1,328 | 1,195 | 0.962 | 1,528 | 1,254 | 1.000 |
| + `askDedup` | 1,248 | 1,116 | 0.962 (0 of 109 lower) | 1,361 | 1,087 | 0.999 (3 of 240 lower)² |
| + `compactAsk` + `compactParts` | 849 | 717 | 0.962 (0 of 109 lower)¹ | 1,010 | 735 | 1.000 (0 of 240 lower) |
| + `compactAsk` + `compactParts` + `askDedup`, `askItemBytes` 240³ | 780 | 648 | 0.951 (9 lower) | 895 | 620 | 0.999 (3 lower) |
| **TOK** = `compactAsk` + `compactParts` + `askDedup` + `cardsEconomy` | **801** | **669** | **0.962 (0 lower)** | **900** | **625** | **0.999 (3 lower)²** |

¹ With `compactParts`; `compactAsk` alone lost the `To:` names in four dev tasks (0.945), which is what (3) above fixed.
² The three are the literal year "2026" in a dated part the packet had already shown as "9 Oct" (`askDedup` counts the
current year as shown) and so the answer says it as shown above.
³ Run before the `To:` and year-as-shown fixes; against the same three flags at 320 then (808 and 914 bytes).

Per suite (TOK against ALL; bytes per task, then the planted item delivered / cited by the ask / either, unchanged):

| suite | bytes/task | answer bytes | delivered | askCited | either |
|---|---|---|---|---|---|
| dev6a | 1,382 → 844 | 1,229 → 692 | 25 | 58 | 59 of 120 |
| dev6b | 1,273 → 758 | 1,161 → 647 | 24 | 50 | 50 of 120 |
| hidden | 1,805 → 978 | 1,548 → 721 | 37 | 32 | 39 of 40 |
| heldout | 1,383 → 805 | 1,125 → 547 | 36 | 26 | 36 of 48 |
| heldout2 | 1,690 → 1,011 | 1,371 → 691 | 50 | 46 | 56 of 60 |
| heldout3 | 1,341 → 754 | 1,098 → 510 | 48 | 40 | 52 of 60 |
| heldout4 | 1,486 → 958 | 1,198 → 671 | 47 | 47 | 57 of 60 |

Cards (`cardsEconomy`, ALL → TOK; replayed, so cost here is $0):

| | dev | in-sample |
|---|---|---|
| items sent to the model | 2,785 → 1,294 (−54%) | 6,660 → 2,970 (−55%) |
| card calls | 411 → 215 (−48%) | 970 → 496 (−49%) |
| items with no replayed card (uncovered) | 339 → 312 | 114 → 84 |

The dev suites' items are not all in the replay file (339 of 2,785 sends uncovered at baseline): those get no card,
in both arms. Not enriched live (no spend in this track).

## Money

Agent input from Eden's bytes, at 1 token ≈ 4 bytes and $0.053 per million input tokens, one ask per task:

- in-sample 1,528 → 900 bytes: $0.0202 → $0.0119 per 1,000 tasks (−$0.0083, −41%);
- dev 1,328 → 801 bytes: $0.0176 → $0.0106 per 1,000 tasks (−$0.0070, −40%).

Cards: Eden's card spend was measured at about $0.036 per 1,000 tasks (econ-synthesis). Items sent fall 54–55% and
calls 48–49%; scaled by items sent, that is about −$0.019 per 1,000 tasks. **Estimate, not measured here** (replay).

Together about −$0.026 to −$0.027 per 1,000 tasks, against an agent cost of about $0.275 per 1,000 tasks (2,100 input
tokens at $0.05/M plus 850 output at $0.20/M): roughly 10% of a task's cost. The byte figure is one read of each
packet and answer; an agent loop re-sends its context on every later turn, so the live saving is larger by the number
of turns after delivery (not measured).

## Tried and left out

- **`askItemBytes` 240**: 19–28 more bytes off a task, but 9 dev and 3 in-sample tasks hold fewer evidence words.
- **A stricter card prefilter.** Of the strict prefilter's sends, those whose only lexicon hits are weak words
  ("hold", "urgent", "important", "received", "got them") were 47 none-verdict and 9 card-verdict items (in-sample,
  unique contents): 26 calendar placeholders titled "Hold" (with 6 more of the same that the model carded as a freeze),
  remittances and claim receipts (2 carded as already-done, the kind the already-paid template needs), and the
  simulator's prompt-injection mails. The verdicts on identical-looking items disagree (the same "Hold" block is none or
  freeze), so a filter fitted to them would fit the model's noise, and it saves about 8% of sends (≈ $0.003 per 1,000
  tasks). Not built.
- **A shorter envelope.** The header and footer are 90 bytes per packet or answer, about 160 of a task's 900 bytes
  in-sample; a shorter header saves 10–20 bytes each and changes what every test and `shownText` match. Not built.
- **Fewer items per answer.** Would cut bytes but changes which items are cited (`askCited`): a ranking change, out of
  this track.

## Risks

- **Live uptake is unmeasured.** The funnel shows the agent is handed the same items and the same evidence words. It
  cannot show whether an agent reading a 625-byte answer raises the fact as often as one reading 1,254 bytes; the
  compacted packet's precedent (D47: live held-out agent cost fell, facts held) is the only evidence. A blind live run
  must decide.
- **`askDedup` assumes the agent still holds the earlier packet.** True in a single conversation; a harness that trims
  or summarises context between turns would see "(shown above)" for an item it no longer has. Tenants with such loops
  should leave it off. Its memory is per session (64 items), never per user.
- **Retention is a proxy.** Content-word overlap with the grader's detail; it misses paraphrase and counts a lost year
  as a lost fact.
- **Signatures.** Compaction drops signatures, where an affiliation ("CFO | Initech") sometimes was the only place the
  agent learned who works where (5 dev tasks lost such a word from a non-planted item's signature under `compactAsk`).
  Packets have always dropped them.
- **`cardsEconomy`** was part of ALL2, which a blind run rejected as a package (D72); it has not been measured blind
  alone. Its 64 unique contents in-sample that lost a non-none card did not change a delivery here.

## Proposed decision

| D73 | 2026-11-01 | Proposed (track tokens). `compactAsk`, `askDedup` and `compactParts`, off by default (`partner.ts`, `render.ts`; docs/research/gen-tokens.md): `ask` answers compacted as packets are (320 bytes an item, dates kept with their year), an answer saying an item this session already showed by its new parts or its title alone (`Session.shown`, 64 items, per session), and compaction reading a quoted thread past a quoted signature, a one-line table by its rows and the To of the user's own sent mail. The tokens configuration TOK = ALL + those three + `cardsEconomy` is proposed for the next pre-registered blind run against ALL; nothing changes ALL until it passes. | No-model funnel, seeds 41–44, this session: every task's delivered and askCited unchanged on dev6a/dev6b and in-sample; agent-read bytes per task 1,328 → 801 (dev) and 1,528 → 900 (in-sample), answers −44% and −50%; card sends −54%/−55%, calls −48%/−49%. About −$0.008 per 1,000 tasks of agent input (measured bytes) and about −$0.019 of card spend (estimated). Evidence-word retention unchanged on dev (0.962) and 0.999 in-sample (3 tasks lose only the year). |
